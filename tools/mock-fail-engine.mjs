/**
 * 「能启动、但一用就报错」的模拟引擎，用来测试运行期报错 → 换模型接手 / 修复 的链路。
 * 体检（--version）能过，真正干活时报错退出。
 */
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('mock-fail 0.1.0\n');
  process.exit(0);
}

process.stderr.write('Error: 模拟的运行期故障（Not logged in · Please run /login）\n');
process.exit(1);
