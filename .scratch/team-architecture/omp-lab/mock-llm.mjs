// 记录 omp 发出的请求，返回一个最短的流式回答。用来在没有真实模型的情况下看 omp 实际拼出的系统提示词。
import http from 'node:http';
import fs from 'node:fs';
const LOG = process.env.MOCK_LOG ?? '/data/omp-lab/requests.jsonl';
const PORT = Number(process.env.MOCK_PORT ?? 18080);
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), method: req.method, url: req.url, body: body ? JSON.parse(body) : null }) + '\n');
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] })); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    res.write(chunk({ role: 'assistant', content: 'ok' }));
    res.write(chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }));
    res.end('data: [DONE]\n\n');
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock on ${PORT}`));
