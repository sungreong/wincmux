#[cfg(windows)]
mod windows_pipe {
    use crate::core::{Core, Filter};
    use serde_json::{json, Value};
    use std::{collections::HashSet, ffi::c_void, io, mem::size_of, sync::Arc};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::windows::named_pipe::{NamedPipeServer, ServerOptions},
        sync::{mpsc, watch},
    };
    use windows::{
        core::{HSTRING, PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL},
            Security::{
                Authorization::{
                    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                },
                GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
                TOKEN_QUERY, TOKEN_USER,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    const MAX_REQUEST: u64 = 12 * 1024 * 1024;

    fn current_user_sid() -> io::Result<String> {
        let windows_error = |err: windows::core::Error| io::Error::other(err.to_string());
        // The pipe can launch terminals, so only the current Windows user and SYSTEM may access it.
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(windows_error)?;
            let result = (|| {
                let mut bytes = 0;
                let _ = GetTokenInformation(token, TokenUser, None, 0, &mut bytes);
                let mut storage = vec![0_usize; (bytes as usize).div_ceil(size_of::<usize>())];
                let ptr = storage.as_mut_ptr().cast::<c_void>();
                GetTokenInformation(token, TokenUser, Some(ptr), bytes, &mut bytes)
                    .map_err(windows_error)?;
                let mut sid = PWSTR::null();
                ConvertSidToStringSidW((*ptr.cast::<TOKEN_USER>()).User.Sid, &mut sid)
                    .map_err(windows_error)?;
                let result = sid
                    .to_string()
                    .map_err(|err| io::Error::other(err.to_string()));
                let _ = LocalFree(Some(HLOCAL(sid.0.cast())));
                result
            })();
            let _ = CloseHandle(token);
            result
        }
    }

    fn open(pipe: &str, acl: &HSTRING, first: bool) -> io::Result<NamedPipeServer> {
        // CreateNamedPipe copies the security descriptor before the call returns.
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(acl.as_ptr()),
                1,
                &mut descriptor,
                None,
            )
            .map_err(|err| io::Error::other(err.to_string()))?;
            let mut attrs = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            };
            let result = ServerOptions::new()
                .reject_remote_clients(true)
                .first_pipe_instance(first)
                .create_with_security_attributes_raw(
                    pipe,
                    (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
                );
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            result
        }
    }

    pub fn serve(core: Arc<Core>, pipe: String) -> io::Result<()> {
        let acl = HSTRING::from(format!("D:P(A;;GA;;;{})(A;;GA;;;SY)", current_user_sid()?));
        let server = tauri::async_runtime::block_on(async { open(&pipe, &acl, true) })?;
        tauri::async_runtime::spawn(async move {
            let mut server = server;
            while server.connect().await.is_ok() {
                let Ok(next) = open(&pipe, &acl, false) else {
                    break;
                };
                let client = std::mem::replace(&mut server, next);
                let core = Arc::clone(&core);
                tauri::async_runtime::spawn(async move {
                    let _ = handle(core, client).await;
                });
            }
        });
        Ok(())
    }

    async fn handle(core: Arc<Core>, client: NamedPipeServer) -> io::Result<()> {
        let (read, mut write) = tokio::io::split(client);
        let mut read = BufReader::new(read);
        let (tx, mut rx) = mpsc::channel::<Value>(64);
        let (overflow, mut closed) = watch::channel(false);
        let mut subscriptions = HashSet::new();
        let mut line = Vec::new();
        let result = loop {
            let mut limited = (&mut read).take(MAX_REQUEST + 1 - line.len() as u64);
            tokio::select! {
                _ = closed.changed() => break Ok(()),
                incoming = limited.read_until(b'\n', &mut line) => {
                    let count = match incoming { Ok(n) => n, Err(err) => break Err(err) };
                    if count == 0 || line.len() as u64 > MAX_REQUEST { break Ok(()); }
                    let request = serde_json::from_slice::<Value>(&line);
                    line.clear();
                    let response = match request {
                        Err(_) => error(Value::Null, -32700, "invalid JSON"),
                        Ok(req) => {
                            let id = req["id"].clone();
                            let method = req["method"].as_str().unwrap_or("");
                            if req["jsonrpc"] != "2.0" || method.is_empty() {
                                error(id, -32600, "invalid request")
                            } else if method == "session.stream.subscribe" {
                                let params = if req["params"].is_null() { json!({}) } else { req["params"].clone() };
                                match serde_json::from_value::<Filter>(params) {
                                    Err(_) => error(id, -32602, "invalid stream filter"),
                                    Ok(filter) => {
                                        let tx = tx.clone();
                                        let overflow = overflow.clone();
                                        let subscription = core.subscribe(filter, Arc::new(move |event| {
                                            if tx.try_send(event).is_err() {
                                                let _ = overflow.send(true);
                                                false
                                            } else { true }
                                        }));
                                        subscriptions.insert(subscription.clone());
                                        success(id, json!({"subscription_id":subscription}))
                                    }
                                }
                            } else if method == "session.stream.unsubscribe" {
                                if let Some(sub) = req["params"]["subscription_id"].as_str() {
                                    if subscriptions.remove(sub) { core.unsubscribe(sub); }
                                }
                                success(id, json!({"ok":true}))
                            } else {
                                let core = Arc::clone(&core);
                                let method = method.to_owned();
                                let params = req["params"].clone();
                                match tauri::async_runtime::spawn_blocking(move || core.rpc(&method, params)).await {
                                    Ok(Ok(value)) => success(id, value),
                                    Ok(Err(err)) => {
                                        let message = err.to_string();
                                        let code = if message.starts_with("method not found:") { -32601 } else { -32000 };
                                        error(id,code,&message)
                                    }
                                    Err(err) => error(id,-32000,&err.to_string()),
                                }
                            }
                        }
                    };
                    if let Err(err) = send(&mut write, response).await { break Err(err); }
                },
                outgoing = rx.recv() => {
                    let Some(event) = outgoing else { break Ok(()); };
                    if let Err(err) = send(&mut write, event).await { break Err(err); }
                },
            }
        };
        for sub in subscriptions {
            core.unsubscribe(&sub);
        }
        result
    }

    async fn send(write: &mut (impl AsyncWriteExt + Unpin), value: Value) -> io::Result<()> {
        let mut data = serde_json::to_vec(&value).map_err(io::Error::other)?;
        data.push(b'\n');
        write.write_all(&data).await
    }

    fn error(id: Value, code: i32, message: &str) -> Value {
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
    }

    fn success(id: Value, result: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":result})
    }
}

#[cfg(windows)]
pub use windows_pipe::serve;
