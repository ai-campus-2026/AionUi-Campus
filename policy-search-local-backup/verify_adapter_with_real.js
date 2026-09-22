// 读取纯净的 query_policy 返回，喂给适配层验证
const ts = require('D:/AI-Campus-Workspace/AionUi-Campus-SSH/node_modules/typescript');
const fs = require('fs');

const src = fs.readFileSync(
  'D:/AI-Campus-Workspace/AionUi-Campus-SSH/packages/desktop/src/renderer/components/campus-rule/adaptPolicyResult.ts',
  'utf8'
);
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const m = { exports: {} };
new Function('exports', 'module', 'require', js)(m.exports, m, require);

let rawJson = fs.readFileSync('D:/AI-Campus-Workspace/AionUi-Campus-SSH/policy-search/query_policy_clean.json', 'utf8');
rawJson = rawJson.replace(/^\uFEFF/, '');
const real = JSON.parse(rawJson);

console.log('=== 真实返回（截断） ===');
console.log(JSON.stringify(real).slice(0, 300) + '...');

// 直接喂给适配层
const adapted = m.exports.tryParseCampusRuleResult(JSON.stringify(real));
console.log('\n=== 适配层输出 ===');
if (!adapted) {
  console.log('❌ 适配层没有识别这个结构！');
} else {
  console.log('type:', adapted.type);
  console.log('summary:', adapted.summary);
  console.log('conclusion:', adapted.conclusion);
  console.log('evidences 数量:', adapted.evidences.length);
  console.log('risks 数量:', adapted.risks.length);
  console.log('suggestions 数量:', adapted.suggestions.length);
  console.log('policyHits 数量:', adapted.policyHits.length);
  console.log('\n--- evidences[0] ---');
  console.log(JSON.stringify(adapted.evidences[0], null, 2));
  console.log('\n--- risks[0] ---');
  console.log(JSON.stringify(adapted.risks[0], null, 2));
  console.log('\n--- suggestions[0] ---');
  console.log(JSON.stringify(adapted.suggestions[0], null, 2));
}
