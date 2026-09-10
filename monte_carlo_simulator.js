#!/usr/bin/env node
/**
 * 甄嬛傳桌遊 — 完整引擎版蒙地卡羅模擬器
 * ================================================
 * 這支腳本不會重寫或簡化你的遊戲規則，而是：
 *   1. 直接讀取你的 index.html，抽出裡面的 <script> 內容（也就是完整的遊戲引擎，
 *      含所有行動卡、道具效果、技能、爭寵、懷孕/分娩邏輯）。
 *   2. 用 Node.js 的 vm 模組把這段程式碼在一個「假瀏覽器」沙盒中執行（提供一個
 *      假的 document.getElementById，因為模擬過程不需要真的畫面）。
 *   3. 把 renderAiThinkingTurn 這個函式換成「立刻執行 AI 回合」而不是原本畫面上
 *      那個 650ms 的思考動畫延遲 —— 這是唯一被覆蓋掉的函式，其餘規則、AI 決策邏輯
 *      （executeAiTurn / executeAiAction）完全沿用你 index.html 裡寫好的版本。
 *   4. 讓五位角色全部設為 AI，一路跑到遊戲自然產生贏家（或觸及安全回合上限），
 *      重複跑 N 局，統計每個角色的勝場數。
 *
 * 使用方式：
 *   node monte_carlo_simulator.js <你的index.html路徑> [模擬局數] [單局安全回合上限] [結果輸出路徑]
 *
 * 範例：
 *   node monte_carlo_simulator.js ./index.html 3000 4000
 *   node monte_carlo_simulator.js ./index.html 3000 4000 ./my_results.json
 *
 * 輸出：
 *   - 終端機印出每個角色的勝場與勝率
 *   - 同目錄下產生 sim_results.json（含詳細數據，方便你之後畫圖或比對）
 *
 * 注意：
 *   - 這個模擬跑的是遊戲內建的 AI 決策邏輯（executeAiTurn/executeAiAction），
 *     不是「理論最優打法」。如果你之後調整了 AI 邏輯或角色數值，直接重跑這支
 *     腳本就能拿到對應新版本的勝率，不需要修改這支腳本本身。
 *   - 若某局在安全回合上限內沒有分出勝負（極端稀有情況），該局會以「目前子嗣
 *     進度最領先者」代替真正贏家計入統計，並在結果中標記為 capped。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = process.argv[2];
const totalGames = parseInt(process.argv[3] || '3000', 10);
const guardMax = parseInt(process.argv[4] || '4000', 10);

if (!htmlPath) {
  console.error('用法：node monte_carlo_simulator.js <index.html路徑> [模擬局數] [單局回合上限]');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) {
  console.error('在指定的 HTML 檔案中找不到 <script> 區塊，請確認路徑正確。');
  process.exit(1);
}
const engineCode = match[1];

// ---- 建立沙盒環境（假瀏覽器）----
const dummyEl = { value: '0', checked: false, textContent: '', classList: { add(){}, remove(){}, contains(){ return false; } } };
const appStub = { innerHTML: '' };
const sandbox = {
  document: {
    getElementById: (id) => (id === 'app' ? appStub : dummyEl)
  },
  console,
  setTimeout, clearTimeout, setInterval, clearInterval
};
vm.createContext(sandbox);
vm.runInContext(engineCode, sandbox);

// ---- 唯一的覆寫：AI 回合立即執行，不等待畫面動畫延遲 ----
vm.runInContext('renderAiThinkingTurn = function(p){ executeAiTurn(p); };', sandbox);

// ---- 單局模擬邏輯（驅動遊戲本身的狀態機，直到自然產生贏家）----
vm.runInContext(`
function __runOneGameFull(guardMax){
  const configs = shuffle(CHARACTERS.map(c => ({ charId: c.id, isAi: true })));
  initGame(configs);
  render();
  let guard = 0;
  while(G.phase !== 'gameOver' && guard < guardMax){
    guard++;
    if(G.phase === 'event'){ resolveEvent(); }
    else if(G.phase === 'favor'){
      if(G.round <= (G.globalFavorPauseUntil||0)){ finishRound(); }
      else { announceFavorWinner(); }
    }
    else { break; }
  }
  if(G.phase === 'gameOver'){
    const w = G.winner;
    return { winner: w.charId, round: G.round, capped:false, princes:w.princes, princesses:w.princesses };
  } else {
    const alive = G.players.filter(p=>p.alive);
    const best = alive.slice().sort((a,b)=> (b.princes*2+b.princesses) - (a.princes*2+a.princesses))[0];
    return { winner: best ? best.charId : null, round: G.round, capped:true, princes:best?best.princes:0, princesses:best?best.princesses:0 };
  }
}
`, sandbox);

const charIds = vm.runInContext('CHARACTERS.map(c => ({ id:c.id, name:c.name }))', sandbox);
const stats = {};
charIds.forEach(c => { stats[c.id] = { name: c.name, wins: 0, princes: 0, princesses: 0 }; });

let cappedCount = 0;
let totalRounds = 0;
const t0 = Date.now();

for (let i = 0; i < totalGames; i++) {
  const r = vm.runInContext(`__runOneGameFull(${guardMax})`, sandbox);
  if (r.capped) cappedCount++;
  if (r.winner) {
    stats[r.winner].wins++;
    stats[r.winner].princes += r.princes;
    stats[r.winner].princesses += r.princesses;
  }
  totalRounds += r.round;
  if ((i + 1) % Math.max(1, Math.floor(totalGames / 10)) === 0) {
    process.stderr.write(`進度：${i + 1}/${totalGames}（已耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）\n`);
  }
}

const elapsedSec = (Date.now() - t0) / 1000;
const avgRounds = totalRounds / totalGames;

const ranking = Object.entries(stats)
  .map(([id, s]) => ({ id, name: s.name, wins: s.wins, winRate: +(100 * s.wins / totalGames).toFixed(2), princesTotal: s.princes, princessesTotal: s.princesses }))
  .sort((a, b) => b.wins - a.wins);

console.log('\n========== 模擬結果 ==========');
console.log(`總局數：${totalGames}　耗時：${elapsedSec.toFixed(1)} 秒　平均回合數：${avgRounds.toFixed(1)}　觸頂局數：${cappedCount}`);
console.log('排名\t角色\t勝場\t勝率');
ranking.forEach((r, i) => {
  console.log(`#${i + 1}\t${r.name}\t${r.wins}\t${r.winRate}%`);
});

const outPath = process.argv[5] || path.join(process.cwd(), 'sim_results.json');
fs.writeFileSync(outPath, JSON.stringify({ totalGames, guardMax, elapsedSec, avgRounds, cappedCount, ranking }, null, 2));
console.log(`\n詳細結果已存成：${outPath}`);
