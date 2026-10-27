import { spawn } from 'node:child_process';
import { log } from './log.js';

// Windows: ask the system to stay awake (the screen may still turn off) for as long as SolBoy runs.
// 2147483649 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED; 2147483648 = ES_CONTINUOUS alone, which releases it.
const windowsScript = (pid) => `
$k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);' -Name 'Awake' -Namespace 'SolBoy' -PassThru
while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) {
  $null = $k::SetThreadExecutionState([uint32]2147483649)
  Start-Sleep -Seconds 20
}
$null = $k::SetThreadExecutionState([uint32]2147483648)
`;

/**
 * Stop the computer from going to sleep on its own while SolBoy runs, using what the OS already
 * provides (nothing to install). Shutting down, restarting or choosing Sleep yourself still work,
 * and normal sleep returns the moment SolBoy closes.
 */
export function keepAwake() {
  const pid = process.pid;
  let cmd, args;
  if (process.platform === 'darwin') {
    // -i: no idle sleep, -s: no system sleep while plugged in, -w: stop when SolBoy exits.
    [cmd, args] = ['caffeinate', ['-i', '-s', '-w', String(pid)]];
  } else if (process.platform === 'win32') {
    [cmd, args] = ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(windowsScript(pid), 'utf16le').toString('base64')]];
  } else {
    [cmd, args] = ['systemd-inhibit', ['--what=idle:sleep', '--who=SolBoy', '--why=Copy trading', '--mode=block', 'sh', '-c', `while kill -0 ${pid} 2>/dev/null; do sleep 20; done`]];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    let closing = false;
    const warn = () => log("Couldn't stop the computer from sleeping by itself. Turn off sleep in your power settings to keep SolBoy running.");
    child.on('error', warn);
    child.on('exit', (code) => !closing && code !== 0 && warn()); // the system refused the request
    process.on('exit', () => {
      closing = true;
      child.kill();
    });
    const tip = process.platform === 'darwin' ? ' Closing the MacBook lid still puts it to sleep, so leave it open (plugged in is best).' : '';
    log(`Keeping your computer awake while SolBoy runs. The screen can still turn off.${tip}`);
  } catch {
    log("Couldn't stop the computer from sleeping by itself. Turn off sleep in your power settings to keep SolBoy running.");
  }
}
