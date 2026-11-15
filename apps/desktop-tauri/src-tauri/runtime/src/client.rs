use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, WriteHalf},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    sync::oneshot,
};

type Reply = std::result::Result<Value, String>;
pub struct Connection {
    writer: tokio::sync::Mutex<WriteHalf<NamedPipeClient>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sequence: AtomicU64,
    read_task: Mutex<Option<tokio::task::AbortHandle>>,
    pub alive: AtomicBool,
}
impl Connection {
    pub async fn connect(
        pipe: &str,
        event: Arc<dyn Fn(Value) + Send + Sync>,
    ) -> std::io::Result<Arc<Self>> {
        let stream = ClientOptions::new().open(pipe)?;
        let (read, write) = tokio::io::split(stream);
        let connection = Arc::new(Self {
            writer: tokio::sync::Mutex::new(write),
            pending: Mutex::default(),
            sequence: AtomicU64::new(1),
            read_task: Mutex::default(),
            alive: AtomicBool::new(true),
        });
        let weak = Arc::downgrade(&connection);
        let task = tokio::spawn(async move {
            let mut read = BufReader::new(read);
            let mut line = Vec::new();
            loop {
                line.clear();
                match (&mut read)
                    .take(12 * 1024 * 1024 + 1)
                    .read_until(b'\n', &mut line)
                    .await
                {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if line.len() > 12 * 1024 * 1024 {
                    break;
                }
                let Ok(packet) = serde_json::from_slice::<Value>(&line) else {
                    break;
                };
                if let Some(id) = packet["id"].as_u64() {
                    let Some(c) = weak.upgrade() else {
                        break;
                    };
                    if let Some(reply) = c.pending.lock().unwrap().remove(&id) {
                        let _ = reply.send(if packet.get("error").is_some() {
                            Err(packet["error"]["message"]
                                .as_str()
                                .unwrap_or("core error")
                                .into())
                        } else {
                            Ok(packet["result"].clone())
                        });
                    };
                } else {
                    event(packet);
                }
            }
            if let Some(c) = weak.upgrade() {
                c.alive.store(false, Ordering::Release);
                for (_, reply) in c.pending.lock().unwrap().drain() {
                    let _ = reply.send(Err(
                        "코어 연결 끊김; 요청은 자동 재전송되지 않았습니다".into()
                    ));
                }
            }
            event(json!({"method":"runtime.disconnected","params":{}}));
        });
        *connection.read_task.lock().unwrap() = Some(task.abort_handle());
        Ok(connection)
    }
    pub async fn request(&self, method: &str, params: Value) -> Reply {
        if !self.alive.load(Ordering::Acquire) {
            return Err("코어 연결 끊김".into());
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let mut data =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
                .unwrap();
        data.push(b'\n');
        if data.len() > 12 * 1024 * 1024 {
            self.pending.lock().unwrap().remove(&id);
            return Err("request exceeds 12 MiB".into());
        }
        let sent = tokio::time::timeout(Duration::from_secs(10), async {
            self.writer.lock().await.write_all(&data).await
        })
        .await;
        if !matches!(sent, Ok(Ok(()))) {
            self.pending.lock().unwrap().remove(&id);
            self.alive.store(false, Ordering::Release);
            return Err("core write failed; request was not retried".into());
        }
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(reply)) => reply,
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err("core request timed out; request was not retried".into())
            }
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        if let Some(task) = self.read_task.get_mut().unwrap().take() {
            task.abort();
        }
    }
}
