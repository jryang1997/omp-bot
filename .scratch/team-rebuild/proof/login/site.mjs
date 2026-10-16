// 09 的假网站，同 02 的 login-proof/site.mjs，多一个 <title>：沙盒里 headless 的 --dump-dom 会卡住，
// 所以 bot 用真浏览器开在自己的屏幕上，从窗口标题读当前登录者。
// /login?user=X 建会话并下发 sid cookie，/ 显示当前登录者，/logout 在服务端吊销会话。
import http from 'node:http';
import { randomBytes } from 'node:crypto';
const sessions = new Map();
const PORT = Number(process.env.SITE_PORT ?? 18091);
http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const page = body => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>${body}</title></head><body><p id="who" style="font-size:48px">${body}</p></body></html>`);
  };
  if (url.pathname === '/login') {
    const id = randomBytes(12).toString('hex');
    sessions.set(id, url.searchParams.get('user') ?? 'anon');
    res.setHeader('set-cookie', `sid=${id}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    return page(`logged-in:${sessions.get(id)}`);
  }
  if (url.pathname === '/logout') {
    if (sid) sessions.delete(sid);
    res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
    return page('logged-out');
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(404); return res.end(); }
  return page(sid && sessions.has(sid) ? `logged-in:${sessions.get(sid)}` : 'anonymous');
}).listen(PORT, '127.0.0.1', () => console.log(`site on ${PORT}`));
