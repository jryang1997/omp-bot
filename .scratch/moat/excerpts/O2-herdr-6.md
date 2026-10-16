# O2-herdr-6 · ClientDetach

detach

证据类型 `SRC`。本轮未执行项目代码或测试。

[固定提交源码](https://github.com/herdrdev/herdr/blob/143bf5fd4781d164260c63fe28e7dc08054ad32f/src/server/headless.rs#L2639-L2648)

完整源文件 [本地快照](原研究包 evidence/source-files)，SHA256 `413808d4f916541783c5f74fd7a98c96bab565175e9a35e4a97293140327f3ba`。

```text
  2639              }
  2640              ServerEvent::ClientDetach { client_id } => {
  2641                  info!(client_id, "client detached");
  2642                  self.send_terminal_stream_detach_shutdown(client_id);
  2643                  self.remove_client_and_resize_if_needed(client_id);
  2644                  true
  2645              }
  2646              ServerEvent::ClientDisconnected { client_id } => {
  2647                  info!(client_id, "client disconnected");
  2648                  self.remove_client_and_resize_if_needed(client_id);
```
