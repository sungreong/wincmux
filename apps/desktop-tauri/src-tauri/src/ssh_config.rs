use russh::keys::{self, PublicKey};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use wincmux_runtime::terminal::hidden_command;

#[derive(Clone, Deserialize, Serialize)]
pub struct Profile {
    pub name: String,
    #[serde(default)]
    pub alias: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub user: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Project {
    pub path: String,
    #[serde(default)]
    pub container: Option<String>,
}

fn default_port() -> u16 {
    22
}

pub struct Target {
    pub host: String,
    pub user: String,
    pub port: u16,
    pub identities: Vec<PathBuf>,
    pub explicit_identity: bool,
    pub use_agent: bool,
    pub known_hosts: Vec<PathBuf>,
    pub system_hosts: Vec<PathBuf>,
    pub host_key_alias: Option<String>,
    pub strict_host_key: bool,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .ok_or_else(|| "Windows 사용자 폴더를 찾을 수 없습니다.".into())
}

fn system_ssh(name: &str) -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
        .join("System32")
        .join("OpenSSH")
        .join(name)
}

fn component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && s.chars().all(|ch| {
            !ch.is_whitespace()
                && !ch.is_control()
                && !matches!(
                    ch,
                    '|' | '('
                        | ')'
                        | '*'
                        | '?'
                        | '!'
                        | ','
                        | '#'
                        | '/'
                        | '\\'
                        | '%'
                        | '@'
                        | '['
                        | ']'
                )
        })
}

fn alias_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && !s.starts_with('-')
        && s.bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn local_path(value: &str, home: &std::path::Path) -> PathBuf {
    let value = value.trim_matches('"');
    value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
        .map(|suffix| home.join(suffix))
        .unwrap_or_else(|| PathBuf::from(value))
}

fn host_paths(value: &str, home: &std::path::Path) -> Result<Vec<PathBuf>, String> {
    if value == "none" {
        return Ok(vec![]);
    }
    let mut paths: Vec<String> = vec![];
    for word in value.split_whitespace() {
        let word = word.trim_matches('"');
        if word.starts_with(['/', '~'])
            || word.as_bytes().get(1) == Some(&b':')
            || word.starts_with("__PROGRAMDATA__")
            || word.starts_with(r"\\")
        {
            paths.push(word.into());
        } else if let Some(previous) = paths.last_mut() {
            previous.push(' ');
            previous.push_str(word);
        } else {
            return Err("SSH 호스트 키 목록의 경로 설정을 확인하세요.".into());
        }
    }
    paths.into_iter().map(|path| {
        if let Some(relative) = path.strip_prefix("__PROGRAMDATA__") {
            let base = std::env::var_os("ProgramData").unwrap_or_else(|| r"C:\ProgramData".into());
            Ok(PathBuf::from(base).join(relative.trim_start_matches(['/', '\\'])))
        } else if path.contains('%') {
            Err("SSH 호스트 키 목록에서 경로 치환이 필요한 설정은 Windows OpenSSH에서 사용하세요.".into())
        } else {
            Ok(local_path(&path, home))
        }
    }).collect()
}

pub fn config_path() -> Result<PathBuf, String> {
    Ok(home()?.join(".ssh").join("config"))
}

fn read_config(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(config) => Ok(config),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(err.to_string()),
    }
}

pub fn aliases() -> Result<Vec<String>, String> {
    Ok(config_aliases(&read_config(&config_path()?)?)
        .into_iter()
        .collect())
}

fn config_aliases(config: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for line in config.trim_start_matches('\u{feff}').lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if let Some((key, value)) = line.split_once(|ch: char| ch.is_whitespace() || ch == '=') {
            if key.eq_ignore_ascii_case("Host") {
                names.extend(
                    value
                        .trim_start_matches('=')
                        .split_whitespace()
                        .map(|value| value.trim_matches('"'))
                        .filter(|value| alias_name(value))
                        .map(str::to_owned),
                );
            }
        }
    }
    names
}

pub fn create_config_file() -> Result<PathBuf, String> {
    let path = config_path()?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|err| err.to_string())?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| err.to_string())?;
    Ok(path)
}

pub fn save_alias(alias: &str, profile: &Profile) -> Result<Vec<String>, String> {
    if !alias_name(alias) {
        return Err("별칭에는 영문, 숫자, 마침표, 밑줄, 하이픈을 사용할 수 있습니다.".into());
    }
    let path = config_path()?;
    let previous = read_config(&path)?;
    let mut names = config_aliases(&previous);
    if names.iter().any(|name| name.eq_ignore_ascii_case(alias)) {
        return Err("이미 사용 중인 SSH 별칭입니다.".into());
    }
    let target = profile.resolve()?;
    if [&target.host, &target.user]
        .into_iter()
        .any(|value| value.contains(['"', '=', '$']))
    {
        return Err("Windows SSH 설정에 저장할 수 없는 호스트 또는 사용자 이름입니다.".into());
    }
    let mut block = format!(
        "Host {alias}\r\n    HostName {}\r\n    User {}\r\n    Port {}\r\n",
        target.host, target.user, target.port
    );
    if target.explicit_identity {
        let path = target.identities[0].to_string_lossy().replace('\\', "/");
        if path.contains(['"', '%', '$']) || path.chars().any(char::is_control) {
            return Err("Windows SSH 설정에 저장할 수 없는 개인 키 경로입니다.".into());
        }
        block.push_str(&format!(
            "    IdentityFile \"{path}\"\r\n    IdentitiesOnly yes\r\n"
        ));
    }
    let body = previous.strip_prefix('\u{feff}').unwrap_or(&previous);
    let bom = if body.len() < previous.len() {
        "\u{feff}"
    } else {
        ""
    };
    // Reset the host condition so the original global directives still apply to every host.
    let config = if body.is_empty() {
        format!("{bom}{block}")
    } else {
        format!("{bom}{block}\r\nHost *\r\n{body}")
    };
    fs::create_dir_all(path.parent().unwrap()).map_err(|err| err.to_string())?;
    let temporary = path.with_extension(format!("wincmux-{}.tmp", uuid::Uuid::new_v4()));
    let written = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|err| err.to_string())?;
        file.write_all(config.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|err| err.to_string())?;
        drop(file);
        if read_config(&path)? != previous {
            return Err(
                "SSH 설정 파일이 변경되었습니다. 목록을 새로 고친 뒤 다시 저장하세요.".into(),
            );
        }
        fs::rename(&temporary, &path).map_err(|err| err.to_string())
    })();
    if written.is_err() {
        let _ = fs::remove_file(temporary);
    }
    written?;
    names.insert(alias.into());
    Ok(names.into_iter().collect())
}

impl Profile {
    pub fn normalize_alias(&mut self) -> Result<(), String> {
        if self.alias.is_empty() {
            return Ok(());
        }
        let names = aliases()?;
        if !names.contains(&self.alias) {
            if let Some(name) = names
                .into_iter()
                .find(|name| name.eq_ignore_ascii_case(&self.alias))
            {
                self.alias = name;
            }
        }
        Ok(())
    }

    pub fn resolve(&self) -> Result<Target, String> {
        let home = home()?;
        let ssh = home.join(".ssh");
        let mut target = Target {
            host: self
                .host
                .trim()
                .trim_start_matches('[')
                .trim_end_matches(']')
                .into(),
            user: self.user.trim().into(),
            port: self.port,
            identities: vec![],
            explicit_identity: !self.identity.is_empty(),
            use_agent: self.identity.is_empty(),
            known_hosts: ["known_hosts", "known_hosts2"]
                .map(|file| ssh.join(file))
                .into(),
            system_hosts: host_paths(
                r"__PROGRAMDATA__\ssh\ssh_known_hosts __PROGRAMDATA__\ssh\ssh_known_hosts2",
                &home,
            )?,
            host_key_alias: None,
            strict_host_key: false,
        };
        if !self.alias.is_empty() {
            if !alias_name(&self.alias) {
                return Err("SSH 별칭을 확인하세요.".into());
            }
            let result = hidden_command(&system_ssh("ssh.exe").to_string_lossy())
                .args(["-G", "--", &self.alias])
                .output()
                .map_err(|err| format!("Windows OpenSSH 설정을 읽을 수 없습니다. {err}"))?;
            if !result.status.success() {
                return Err("Windows OpenSSH에서 이 별칭의 설정을 읽을 수 없습니다.".into());
            }
            for line in String::from_utf8_lossy(&result.stdout).lines() {
                let Some((key, value)) = line.split_once(' ') else {
                    continue;
                };
                match key {
                    "hostname" => target.host = value.into(),
                    "user" => target.user = value.into(),
                    "port" => {
                        target.port = value.parse().map_err(|_| "SSH 포트가 잘못되었습니다.")?
                    }
                    "identityfile" if value != "none" => {
                        target.identities.push(local_path(value, &home))
                    }
                    "identitiesonly" if value == "yes" => target.use_agent = false,
                    "hostkeyalias" if value != "none" => target.host_key_alias = Some(value.into()),
                    "stricthostkeychecking" => {
                        target.strict_host_key = value == "true" || value == "yes"
                    }
                    "userknownhostsfile" => target.known_hosts = host_paths(value, &home)?,
                    "globalknownhostsfile" => target.system_hosts = host_paths(value, &home)?,
                    "identityagent" if value == "none" => target.use_agent = false,
                    "proxyjump" | "proxycommand" | "revokedhostkeys" | "certificatefile"
                        if value != "none" =>
                    {
                        return Err(format!("이 SSH 별칭의 {key} 설정은 VS Code 또는 Windows OpenSSH에서 사용하세요."));
                    }
                    _ => {}
                }
            }
        } else if self.identity.is_empty() {
            target.identities = ["id_ed25519", "id_ecdsa", "id_rsa"]
                .map(|name| ssh.join(name))
                .into();
        } else {
            target.identities.push(local_path(&self.identity, &home));
        }
        if !component(&target.host)
            || !component(&target.user)
            || target.port == 0
            || target
                .host_key_alias
                .as_deref()
                .is_some_and(|alias| !component(alias))
        {
            return Err("SSH 호스트, 사용자 이름, 포트를 확인하세요.".into());
        }
        if target.explicit_identity && !target.identities.iter().any(|path| path.is_file()) {
            return Err("선택한 SSH 개인 키 파일을 찾을 수 없습니다.".into());
        }
        Ok(target)
    }
}

impl Target {
    fn host_identity(&self) -> (&str, u16) {
        self.host_key_alias
            .as_deref()
            .map(|alias| (alias, 22))
            .unwrap_or((&self.host, self.port))
    }

    pub fn trusted(&self, presented: &PublicKey) -> Result<bool, String> {
        let (host, port) = self.host_identity();
        let lookup = if port == 22 {
            host.into()
        } else {
            format!("[{host}]:{port}")
        };
        let mut recognized = false;
        let mut matching = false;
        for file in self.known_hosts.iter().chain(&self.system_hosts) {
            match file.try_exists() {
                Ok(false) => continue,
                Err(err) => return Err(err.to_string()),
                Ok(true) => {}
            }
            let result = hidden_command(&system_ssh("ssh-keygen.exe").to_string_lossy())
                .args(["-F", &lookup, "-f"])
                .arg(file)
                .output()
                .map_err(|err| err.to_string())?;
            if !result.status.success()
                && (!result.stderr.is_empty() || result.status.code() != Some(1))
            {
                return Err(format!(
                    "SSH 호스트 키 목록을 읽을 수 없습니다. {}",
                    file.display()
                ));
            }
            for line in String::from_utf8_lossy(&result.stdout).lines() {
                let mut fields = line.split_whitespace();
                match fields.next() {
                    None | Some("#") => continue,
                    Some("@revoked" | "@cert-authority") => {
                        return Err("이 호스트의 인증서 또는 폐기된 키 설정은 Windows OpenSSH에서 확인하세요.".into());
                    }
                    Some(_) => {}
                }
                fields.next();
                let key = fields
                    .next()
                    .and_then(|key| keys::parse_public_key_base64(key).ok());
                recognized = true;
                matching |= key.is_some_and(|key| key.key_data() == presented.key_data());
            }
        }
        if recognized && !matching {
            return Err(
                "저장된 SSH 서버 키와 일치하지 않습니다. 서버 관리자에게 변경 여부를 확인하세요."
                    .into(),
            );
        }
        if !matching && (self.strict_host_key || self.known_hosts.is_empty()) {
            return Err("SSH 설정에서 이 서버의 신뢰 키를 미리 등록하도록 요구합니다. Windows OpenSSH 설정을 확인하세요.".into());
        }
        Ok(matching)
    }

    pub fn trust(&self, key: &PublicKey) -> Result<(), String> {
        if !self.trusted(key)? {
            let (host, port) = self.host_identity();
            let path = self
                .known_hosts
                .first()
                .ok_or("SSH 호스트 키를 저장할 경로가 없습니다.")?;
            keys::known_hosts::learn_known_hosts_path(host, port, key, path)
                .map_err(|err| err.to_string())?;
        }
        Ok(())
    }
}
