const fs = await import('node:fs/promises');
const root = 'C:/Users/<user>/Desktop/omp_bot/.scratch/ego-browser-research/';
const task = await taskSpace(4);
const page = task.page('p1');
const snapshot = await page.snapshot();
const result = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter(row => !row.hidden).map(row => ({city:row.cells[0].textContent,value:Number(row.cells[1].textContent)})));
if (JSON.stringify(result) !== JSON.stringify([{city:'北京',value:37}])) throw new Error('Unexpected recovered fixture result: ' + JSON.stringify(result));
const proof = {status:'SEMANTIC_PASS', surface:'Installed Windows Ego Lite 0.5.2.15', spaceId:task.spaceId, result, snapshot, egoTested:true, timingComparison:false, modelComparison:false, screenshot:{highLevel:'Page.captureScreenshot timed out in first round'}, closed:false, scope:'Capability smoke on own local fixture, not a performance benchmark'};
await fs.writeFile(root + 'ego-batch-proof.json', JSON.stringify(proof,null,2),'utf8');
try {
  const shot = await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:false},{timeout:5000});
  await fs.writeFile(root + 'ego-batch-proof.png',Buffer.from(shot.data,'base64'));
  proof.screenshot.rawCdp = 'PASS';
  proof.screenshot.path = root + 'ego-batch-proof.png';
} catch (error) {
  proof.screenshot.rawCdp = String(error.message);
}
const receipt = await task.finish({keep:[]});
proof.closed = true;
proof.finishReceipt = receipt;
await fs.writeFile(root + 'ego-batch-proof.json',JSON.stringify(proof,null,2),'utf8');
console.log(JSON.stringify({status:proof.status,result,screenshot:proof.screenshot,closed:proof.closed}));
