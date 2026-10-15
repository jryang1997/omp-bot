const fs = await import('node:fs/promises');
const root = 'C:/Users/Jerry/Desktop/omp_bot/.scratch/ego-browser-research/';
const task = await taskSpace('omp_bot browser efficiency probe');
await fs.writeFile(root + 'ego-space-proof.json', JSON.stringify({spaceId: task.spaceId, status: 'STARTED'}, null, 2), 'utf8');
console.log({spaceId: task.spaceId});
const page = task.page('p1');
await page.goto('about:blank');
await page.evaluate(() => {
  document.title = 'OMP Bot browser fixture';
  document.body.innerHTML = '<h1>浏览器自动化探针</h1><label>城市 <input id="city"></label><button id="filter">筛选</button><table><thead><tr><th>城市</th><th>数值</th></tr></thead><tbody><tr data-city="北京"><td>北京</td><td>37</td></tr><tr data-city="上海"><td>上海</td><td>52</td></tr></tbody></table>';
  document.querySelector('#filter').addEventListener('click', () => {
    const city = document.querySelector('#city').value;
    for (const row of document.querySelectorAll('tbody tr')) row.hidden = row.dataset.city !== city;
  });
});
const before = await page.snapshot();
await page.fill('#city', '北京');
await page.click('#filter');
const result = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter(row => !row.hidden).map(row => ({city: row.cells[0].textContent, value: Number(row.cells[1].textContent)})));
if (JSON.stringify(result) !== JSON.stringify([{city:'北京',value:37}])) throw new Error('Unexpected filtered rows: ' + JSON.stringify(result));
const after = await page.snapshot();
const screenshot = await page.screenshot({path: root + 'ego-batch-proof.png'});
await task.finish({keep: []});
const proof = {status:'PASS', surface:'Installed Windows Ego Lite 0.5.2.15', spaceId:task.spaceId, actions:['create own Space','create local fixture','snapshot','fill','click','extract and assert exact visible row','screenshot','finish'], result, before, after, screenshot, closed:true, egoTested:true, timingComparison:false, modelComparison:false, scope:'Deterministic local fixture; capability smoke only, not Ego versus CUA benchmark'};
await fs.writeFile(root + 'ego-batch-proof.json', JSON.stringify(proof, null, 2), 'utf8');
console.log(JSON.stringify({status:proof.status,result,closed:true}));
