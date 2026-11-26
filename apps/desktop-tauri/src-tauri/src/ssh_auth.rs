use crate::{
    ssh_config::{Profile, Target},
    ssh_credentials,
};
use russh::{
    client::{self, AuthResult, KeyboardInteractiveAuthResponse},
    keys::{
        self, agent::client::AgentClient, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey,
        PublicKeyOrCertificate,
    },
    MethodKind, MethodSet,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use zeroize::Zeroizing;

pub struct HostKey {
    seen: Arc<Mutex<Option<PublicKey>>>,
}

impl client::Handler for HostKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        presented: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = presented else {
            return Ok(false);
        };
        let mut seen = self.seen.lock().unwrap();
        if let Some(previous) = seen.as_ref() {
            return Ok(previous.key_data() == key.key_data());
        }
        *seen = Some(key.clone());
        Ok(true)
    }
}

pub type Handle = client::Handle<HostKey>;

enum Challenge {
    HostKey(PublicKey),
    Password,
    Interactive(usize),
    Passphrase(PathBuf),
}

pub struct Auth {
    pub handle: Handle,
    pub profile: Profile,
    pub credential_key: String,
    target: Target,
    challenge: Option<Challenge>,
    methods: MethodSet,
    identities: Vec<PathBuf>,
    rounds: usize,
    checked_cache: bool,
}

impl Auth {
    pub async fn begin(mut profile: Profile) -> Result<(Self, Value), String> {
        let (profile, target) = tokio::task::spawn_blocking(move || {
            profile.normalize_alias()?;
            let target = profile.resolve()?;
            Ok::<_, String>((profile, target))
        })
        .await
        .map_err(error)??;
        Self::connect(profile, target).await
    }

    async fn connect(profile: Profile, target: Target) -> Result<(Self, Value), String> {
        let seen = Arc::new(Mutex::new(None));
        let config = client::Config {
            keepalive_interval: Some(Duration::from_secs(20)),
            keepalive_max: 3,
            ..Default::default()
        };
        let handle = client::connect(
            Arc::new(config),
            (target.host.as_str(), target.port),
            HostKey { seen: seen.clone() },
        )
        .await
        .map_err(|err| format!("SSH 연결에 실패했습니다. {err}"))?;
        let key = seen
            .lock()
            .unwrap()
            .clone()
            .ok_or("서버에서 SSH 호스트 키를 받지 못했습니다.")?;
        let trusted = target.trusted(&key)?;
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let credential_key = format!(
            "WinCMux.SSH:{}@[{}]:{}/{}",
            target.user,
            target.host.to_ascii_lowercase(),
            target.port,
            fingerprint
        );
        let mut auth = Self {
            handle,
            profile,
            credential_key,
            methods: MethodSet::empty(),
            identities: target.identities.clone(),
            target,
            challenge: None,
            rounds: 0,
            checked_cache: false,
        };
        let result = if trusted {
            auth.start_authentication().await?
        } else {
            auth.challenge = Some(Challenge::HostKey(key));
            json!({"state":"host_key","host":auth.target.host,"port":auth.target.port,"fingerprint":fingerprint})
        };
        Ok((auth, result))
    }

    pub async fn confirm(&mut self) -> Result<Value, String> {
        let Some(Challenge::HostKey(key)) = self.challenge.take() else {
            return Err("확인할 SSH 호스트 키가 없습니다.".into());
        };
        self.target.trust(&key)?;
        self.start_authentication().await
    }

    async fn start_authentication(&mut self) -> Result<Value, String> {
        let result = self
            .handle
            .authenticate_none(&self.target.user)
            .await
            .map_err(error)?;
        if self.accept(result) {
            return Ok(connected());
        }
        if self.target.use_agent
            && self.methods.contains(&MethodKind::PublicKey)
            && self.try_agent().await?
        {
            return Ok(connected());
        }
        self.next_identity().await
    }

    async fn try_agent(&mut self) -> Result<bool, String> {
        let Ok(mut agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
        else {
            return Ok(false);
        };
        let Ok(identities) = agent.request_identities().await else {
            return Ok(false);
        };
        for identity in identities.into_iter().take(3) {
            let key = identity.public_key().into_owned();
            let hash = self.rsa_hash(key.algorithm().is_rsa()).await?;
            if let Ok(result) = self
                .handle
                .authenticate_publickey_with(&self.target.user, key, hash, &mut agent)
                .await
            {
                if self.accept(result) {
                    return Ok(true);
                }
                if !self.methods.contains(&MethodKind::PublicKey) {
                    break;
                }
            }
        }
        Ok(false)
    }

    async fn next_identity(&mut self) -> Result<Value, String> {
        while self.methods.contains(&MethodKind::PublicKey) && !self.identities.is_empty() {
            let path = self.identities.remove(0);
            if !path.is_file() {
                continue;
            }
            match keys::load_secret_key(&path, None) {
                Ok(key) => {
                    if self.try_key(key).await? {
                        return Ok(connected());
                    }
                }
                Err(keys::Error::KeyIsEncrypted) => {
                    let filename = path.file_name().unwrap_or_default().to_string_lossy();
                    let label = format!("{filename} 키 암호");
                    self.challenge = Some(Challenge::Passphrase(path));
                    return Ok(prompt("passphrase", &label, ""));
                }
                Err(err) if self.target.explicit_identity => {
                    return Err(format!("SSH 개인 키를 열 수 없습니다. {err}"))
                }
                Err(_) => {}
            }
        }
        self.prompt_or_cached().await
    }

    async fn prompt_or_cached(&mut self) -> Result<Value, String> {
        if !self.checked_cache && self.methods.contains(&MethodKind::Password) {
            self.checked_cache = true;
            if let Ok(Some(secret)) = ssh_credentials::read(&self.credential_key) {
                let result = self
                    .handle
                    .authenticate_password(&self.target.user, secret.as_str())
                    .await
                    .map_err(error)?;
                let rejected = matches!(
                    &result,
                    AuthResult::Failure {
                        partial_success: false,
                        ..
                    }
                );
                if self.accept(result) {
                    return Ok(
                        json!({"state":"connected","password_cached":true,"used_cached_password":true}),
                    );
                }
                if rejected {
                    let _ = ssh_credentials::remove(&self.credential_key);
                    return self
                        .try_prompt("저장된 비밀번호가 거부되었습니다. 현재 비밀번호를 입력하세요.")
                        .await;
                }
            }
        }
        self.try_prompt("").await
    }

    async fn try_key(&mut self, key: PrivateKey) -> Result<bool, String> {
        let hash = self.rsa_hash(key.algorithm().is_rsa()).await?;
        let result = self
            .handle
            .authenticate_publickey(
                &self.target.user,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(error)?;
        Ok(self.accept(result))
    }

    async fn rsa_hash(&self, is_rsa: bool) -> Result<Option<HashAlg>, String> {
        if is_rsa {
            return Ok(Some(
                self.handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(error)?
                    .flatten()
                    .unwrap_or(HashAlg::Sha256),
            ));
        }
        Ok(None)
    }

    fn accept(&mut self, result: AuthResult) -> bool {
        match result {
            AuthResult::Success => true,
            AuthResult::Failure {
                remaining_methods, ..
            } => {
                self.methods = remaining_methods;
                false
            }
        }
    }

    async fn try_prompt(&mut self, message: &str) -> Result<Value, String> {
        if self.methods.contains(&MethodKind::Password) {
            self.challenge = Some(Challenge::Password);
            return Ok(prompt(
                "password",
                &format!("{}@{} 비밀번호", self.target.user, self.target.host),
                message,
            ));
        }
        if self.methods.contains(&MethodKind::KeyboardInteractive) {
            let response = self
                .handle
                .authenticate_keyboard_interactive_start(&self.target.user, None::<String>)
                .await
                .map_err(error)?;
            return self.interactive(response, message);
        }
        Err("SSH 인증에 실패했습니다. 계정 이름과 서버에 등록된 SSH 키를 확인하세요.".into())
    }

    fn interactive(
        &mut self,
        response: KeyboardInteractiveAuthResponse,
        message: &str,
    ) -> Result<Value, String> {
        match response {
            KeyboardInteractiveAuthResponse::Success => Ok(connected()),
            KeyboardInteractiveAuthResponse::Failure { .. } =>
                Err("서버가 대화형 SSH 인증을 거부했습니다. 계정과 인증 수단을 확인한 후 다시 연결하세요.".into()),
            KeyboardInteractiveAuthResponse::InfoRequest { instructions, prompts, .. } if prompts.len() <= 16 => {
                self.challenge = Some(Challenge::Interactive(prompts.len()));
                let prompts: Vec<_> = prompts.into_iter().map(|prompt| json!({
                    "label":prompt.prompt.chars().take(300).collect::<String>(),"echo":prompt.echo
                })).collect();
                Ok(json!({"state":"prompt","kind":"interactive","message":message,
                    "instructions":instructions.chars().take(1000).collect::<String>(),"prompts":prompts}))
            }
            _ => Err("서버에서 너무 많은 SSH 인증 항목을 요청했습니다.".into()),
        }
    }

    pub async fn answer(
        &mut self,
        mut answers: Vec<String>,
        remember: bool,
    ) -> Result<Value, String> {
        self.rounds += 1;
        if self.rounds > 12 || answers.iter().any(|input| input.len() > 2048) {
            return Err("SSH 인증 시도 한도를 초과했습니다. 다시 연결하세요.".into());
        }
        match self.challenge.take() {
            Some(Challenge::Password) if answers.len() == 1 => {
                let password = Zeroizing::new(answers.remove(0));
                let result = self
                    .handle
                    .authenticate_password(&self.target.user, password.as_str())
                    .await
                    .map_err(error)?;
                let message = match &result {
                    AuthResult::Failure {
                        partial_success: true,
                        ..
                    } => "",
                    _ => "비밀번호가 거부되었습니다. 다시 입력하세요.",
                };
                if self.accept(result) {
                    let mut connected = connected();
                    if remember {
                        match ssh_credentials::save(&self.credential_key, password.as_str()) {
                            Ok(()) => connected["password_cached"] = json!(true),
                            Err(err) => {
                                connected["message"] = json!(format!(
                                    "연결됐지만 Windows에 비밀번호를 저장할 수 없습니다. {err}"
                                ))
                            }
                        }
                    }
                    Ok(connected)
                } else {
                    self.try_prompt(message).await
                }
            }
            Some(Challenge::Interactive(count)) if answers.len() == count => {
                let response = self
                    .handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(error)?;
                self.interactive(response, "")
            }
            Some(Challenge::Passphrase(path)) if answers.len() <= 1 => {
                if let Some(passphrase) = answers.pop() {
                    let Ok(key) = keys::load_secret_key(&path, Some(&passphrase)) else {
                        self.challenge = Some(Challenge::Passphrase(path));
                        return Ok(prompt(
                            "passphrase",
                            "SSH 키 암호",
                            "키를 열 수 없습니다. 암호를 다시 입력하세요.",
                        ));
                    };
                    drop(passphrase);
                    if self.try_key(key).await? {
                        return Ok(connected());
                    }
                }
                self.next_identity().await
            }
            _ => Err("현재 SSH 연결에서 요청한 인증 항목을 확인하세요.".into()),
        }
    }
}

fn connected() -> Value {
    json!({"state":"connected"})
}

fn prompt(kind: &str, label: &str, message: &str) -> Value {
    json!({"state":"prompt","kind":kind,"message":message,"prompts":[{"label":label,"echo":false}]})
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{server, Channel, ChannelId};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use uuid::Uuid;

    struct Fixture(Arc<AtomicUsize>, Arc<AtomicUsize>, Arc<AtomicUsize>);

    impl server::Handler for Fixture {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<server::Auth, Self::Error> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(if user == "fixture" && password == "fixture-password" {
                server::Auth::Accept
            } else {
                server::Auth::Reject {
                    proceed_with_methods: Some(MethodSet::from([MethodKind::Password].as_slice())),
                    partial_success: false,
                }
            })
        }

        async fn channel_open_session(
            &mut self,
            _: Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> Result<(), Self::Error> {
            if self.1.fetch_add(1, Ordering::SeqCst) == 0 {
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                return Ok(());
            }
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut server::Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            if data == b"hold open" {
                return Ok(());
            }
            session.data(channel, data.to_vec())?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)
        }

        async fn channel_close(
            &mut self,
            _: ChannelId,
            _: &mut server::Session,
        ) -> Result<(), Self::Error> {
            self.2.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn unknown_host_password_retry_and_shared_connection() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("ssh-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let private_key = root.join("host_ed25519");
        let keygen = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/OpenSSH/ssh-keygen.exe");
        assert!(
            wincmux_runtime::terminal::hidden_command(&keygen.to_string_lossy())
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(&private_key)
                .status()
                .unwrap()
                .success()
        );
        let key = keys::load_secret_key(&private_key, None).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let count = Arc::new(AtomicUsize::new(0));
        let channel_attempts = Arc::new(AtomicUsize::new(0));
        let closed_channels = Arc::new(AtomicUsize::new(0));
        let methods = MethodSet::from([MethodKind::Password].as_slice());
        let config = Arc::new(server::Config {
            keys: vec![key],
            methods,
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        let server_count = count.clone();
        let server_channel_attempts = channel_attempts.clone();
        let server_closed_channels = closed_channels.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            server::run_stream(
                config,
                socket,
                Fixture(
                    server_count,
                    server_channel_attempts,
                    server_closed_channels,
                ),
            )
            .await
            .unwrap()
            .await
            .unwrap();
        });
        let profile = Profile {
            name: "fixture".into(),
            alias: String::new(),
            host: "127.0.0.1".into(),
            user: "fixture".into(),
            port,
            identity: String::new(),
            project: None,
        };
        let target = Target {
            host: profile.host.clone(),
            user: profile.user.clone(),
            port,
            identities: vec![],
            explicit_identity: false,
            use_agent: false,
            known_hosts: vec![root.join("known_hosts")],
            system_hosts: vec![],
            host_key_alias: None,
            strict_host_key: false,
        };
        tokio::time::timeout(Duration::from_secs(12), async {
            let (mut auth, first) = Auth::connect(profile, target).await.unwrap();
            assert_eq!(first["state"], "host_key");
            assert!(first["fingerprint"]
                .as_str()
                .unwrap()
                .starts_with("SHA256:"));
            assert_eq!(count.load(Ordering::SeqCst), 0);
            let ask = auth.confirm().await.unwrap();
            assert_eq!(ask["kind"], "password");
            assert_eq!(ask["prompts"][0]["echo"], false);
            let rejected = auth.answer(vec!["incorrect".into()], false).await.unwrap();
            assert_eq!(rejected["kind"], "password");
            assert!(!rejected["message"].as_str().unwrap().is_empty());
            let connected = auth
                .answer(vec!["fixture-password".into()], true)
                .await
                .unwrap();
            assert_eq!(connected["state"], "connected");
            assert_eq!(connected["password_cached"], true);
            let secret = ssh_credentials::read(&auth.credential_key)
                .unwrap()
                .unwrap();
            assert_eq!(secret.as_str(), "fixture-password");
            ssh_credentials::remove(&auth.credential_key).unwrap();
            assert_eq!(
                crate::ssh_terminal::run(&auth.handle, "first channel".into(), 128)
                    .await
                    .unwrap(),
                b"first channel"
            );
            assert_eq!(
                crate::ssh_terminal::run(&auth.handle, "second channel".into(), 128)
                    .await
                    .unwrap(),
                b"second channel"
            );
            assert_eq!(count.load(Ordering::SeqCst), 2);
            assert_eq!(channel_attempts.load(Ordering::SeqCst), 3);
            let released_before = closed_channels.load(Ordering::SeqCst);
            let released_timeout = tokio::time::timeout(Duration::from_millis(100), async {
                let mut channel = auth.handle.channel_open_session().await.unwrap();
                channel.exec(true, "hold open").await.unwrap();
                while channel.wait().await.is_some() {}
            })
            .await;
            assert!(released_timeout.is_err());
            tokio::time::sleep(Duration::from_millis(40)).await;
            assert_eq!(closed_channels.load(Ordering::SeqCst), released_before);
            let before_timeout = closed_channels.load(Ordering::SeqCst);
            let error = crate::ssh_terminal::run_with_timeout(
                &auth.handle,
                "hold open".into(),
                128,
                Duration::from_millis(150),
            )
            .await
            .unwrap_err();
            assert!(error.contains("시간이 초과"));
            tokio::time::timeout(Duration::from_secs(2), async {
                while closed_channels.load(Ordering::SeqCst) == before_timeout {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("timed-out channel must be closed on the server");
            assert!(root.join("known_hosts").is_file());
        })
        .await
        .unwrap();
        server.abort();
    }
}
