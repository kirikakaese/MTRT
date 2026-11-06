// Keep the machine awake while armed (macOS: caffeinate; Linux: systemd-inhibit).
import { spawn, spawnSync } from 'node:child_process';

let proc = null;
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

export function keepAwake(on) {
  if (on && !proc) {
    if (process.platform === 'darwin') proc = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
    else if (process.platform === 'linux' && has('systemd-inhibit')) proc = spawn('systemd-inhibit', ['--what=idle:sleep', '--who=mtrt', '--why=armed', 'sleep', 'infinity'], { stdio: 'ignore' });
    proc?.on('error', () => { proc = null; });
    proc?.on('exit', () => { proc = null; });
  } else if (!on && proc) {
    proc.kill(); proc = null;
  }
  return !!proc;
}
export const isAwakeHeld = () => !!proc;
process.on('exit', () => proc?.kill());
