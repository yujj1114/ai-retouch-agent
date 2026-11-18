/* Node 冒烟测试：Agent 意图解析 / 计划生成 / 校验 / 拓扑排序 */
const fs = require('fs');
const path = require('path');
global.window = globalThis;
const root = path.join(__dirname, '..');
eval(fs.readFileSync(path.join(root, 'src/tools.js'), 'utf8'));
eval(fs.readFileSync(path.join(root, 'src/agent.js'), 'utf8'));

const Agent = RA.Agent;
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra || ''); }
}

const cases = [
  ['亮一点', ['adjust_brightness']],
  ['太暗了，提亮一些', ['adjust_brightness']],
  ['把背景换成海边', ['smart_replace_bg']],
  ['提高亮度和饱和度，再加一点胶片感', ['adjust_brightness', 'adjust_saturation', 'filter_film']],
  ['裁剪成1:1然后旋转一下', ['transform_crop', 'transform_rotate']],
  ['抠出主体', ['smart_matting']],
  ['背景虚化', ['smart_replace_bg']],
  ['加一点胶片感', ['filter_film']],
  ['消除路人', ['brush_remove']],
  ['黑白', ['filter_bw']],
  ['暖一点', ['adjust_temperature']],
  ['冷一些', ['adjust_temperature']],
  ['高清放大到2倍', ['smart_superres']],
  ['扩图', ['smart_expand']],
  ['暗角加一点', ['adjust_vignette']],
  ['磨皮', ['filter_portrait']],
  ['局部提亮眼睛', ['brush_lighten']],
  ['水平翻转', ['transform_flip_h']],
  ['色温暖一些再加颗粒', ['adjust_temperature', 'adjust_grain']],
  ['去掉背景', ['smart_matting']],
  ['画面整体提亮', ['adjust_brightness']],
  ['暗角加一点，不要颗粒', ['adjust_vignette']],
  ['今天天气怎么样', []],
];

console.log('— 意图解析 —');
for (const [text, expect] of cases) {
  const r = Agent.parse(text);
  const got = r.ops.map((o) => o.tool);
  check(`"${text}" → [${got.join(', ')}]`, JSON.stringify(got) === JSON.stringify(expect), `expect [${expect.join(', ')}]`);
}

console.log('— 参数抽取 —');
{
  const r = Agent.parse('亮 40');
  check('亮 40 → brightness +40', r.ops[0] && r.ops[0].params.value === 40, JSON.stringify(r.ops[0] && r.ops[0].params));
}
{
  const r = Agent.parse('把背景换成蓝色');
  check('背景换成蓝色 → color #2980b9', r.ops[0] && r.ops[0].params.type === 'color' && r.ops[0].params.color === '#2980b9', JSON.stringify(r.ops[0] && r.ops[0].params));
}
{
  const r = Agent.parse('背景换成森林');
  check('背景换成森林 → gradient 森林', r.ops[0] && r.ops[0].params.preset === '森林', JSON.stringify(r.ops[0] && r.ops[0].params));
}
{
  const r = Agent.parse('裁剪成16:9');
  check('裁剪成16:9', r.ops[0] && r.ops[0].params.ratio === '16:9', JSON.stringify(r.ops[0] && r.ops[0].params));
}
{
  const r = Agent.parse('饱和度提高30');
  check('饱和度提高30 → +30', r.ops[0] && r.ops[0].params.value === 30, JSON.stringify(r.ops[0] && r.ops[0].params));
}

console.log('— 计划与校验 —');
{
  const parsed = Agent.parse('提高亮度和饱和度，再加一点胶片感');
  const plan = Agent.buildPlan(parsed.ops, 'test');
  check('计划步数 = 3', plan.steps.length === 3);
  check('步骤依赖链 s2→s1, s3→s2', plan.steps[1].dependsOn[0] === 's1' && plan.steps[2].dependsOn[0] === 's2');
  const v = Agent.verify(plan);
  check('校验通过', v.ok, JSON.stringify(v.errors));
  const order = Agent.topoOrder(plan.steps).map((s) => s.id);
  check('拓扑序 = s1,s2,s3', JSON.stringify(order) === JSON.stringify(['s1', 's2', 's3']));
}
{
  // 构造非法计划：参数越界 + 工具不存在 + 循环依赖
  const bad = {
    steps: [
      { id: 'a', tool: 'adjust_brightness', params: { value: 999 }, dependsOn: [] },
      { id: 'b', tool: 'no_such_tool', params: {}, dependsOn: ['a'] },
      { id: 'c', tool: 'filter_bw', params: {}, dependsOn: ['b', 'd'] },
      { id: 'd', tool: 'filter_film', params: {}, dependsOn: ['c'] },
    ],
  };
  const v = Agent.verify(bad);
  check('非法计划被拒绝', !v.ok);
  check('检出参数越界', v.errors.some((e) => e.includes('超出范围')), v.errors.join('|'));
  check('检出工具不存在', v.errors.some((e) => e.includes('工具不存在')));
  check('检出循环依赖', v.errors.some((e) => e.includes('循环依赖')));
}

console.log('— 注册表 —');
check('工具数 ≥ 21', RA.ToolRegistry.specs.length >= 21, 'got ' + RA.ToolRegistry.specs.length);
check('工具 id 唯一', new Set(RA.ToolRegistry.specs.map((s) => s.id)).size === RA.ToolRegistry.specs.length);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
