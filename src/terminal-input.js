import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { join } from 'node:path';

export const MAX_INPUT_BYTES = 64 * 1024;

export function validateTerminalInput({ terminalId, data, eof }) {
  if (typeof terminalId !== 'string' || !terminalId || terminalId.length > 1024 ||
      typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES ||
      (eof !== undefined && typeof eof !== 'boolean')) throw new Error('终端输入参数无效（data 最多 64 KiB）');
}

export class TerminalProcesses {
  constructor() { this.processes = new Map(); }

  async input(params) {
    validateTerminalInput(params);
    const child = this.processes.get(params.terminalId);
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
      throw new Error('终端不存在、已退出或 stdin 已关闭');
    }
    await new Promise((resolve, reject) => {
      const done = error => error ? reject(error) : resolve();
      if (params.eof) child.stdin.end(params.data, 'utf8', done);
      else child.stdin.write(params.data, 'utf8', done);
    });
  }

  kill(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    }
  }

  close() {
    for (const child of this.processes.values()) this.kill(child);
  }

  async exec(terminalId, shell, command, cwd, { onData, signal, timeout, env }, ready) {
    if (signal?.aborted) throw new Error('aborted');
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)) {
      throw new Error('Invalid timeout');
    }
    // shortcut: stdin 管道不提供 PTY；需要全屏程序、终端尺寸或 tty 密码提示时再接入 PTY。
    if (shell.commandTransport === 'stdin') throw new Error('此 shell 使用 stdin 传递命令，无法提供交互输入');
    const child = spawn(shell.shell, [...shell.args, command], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
    });
    this.processes.set(terminalId, child);
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => onData(data, 'stdout'));
    child.stderr.on('data', data => onData(data, 'stderr'));
    let timedOut = false;
    const abort = () => this.kill(child);
    const timer = timeout === undefined ? undefined : setTimeout(() => { timedOut = true; abort(); }, timeout * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const exitCode = await new Promise((resolve, reject) => {
        let exited = false;
        let idleTimer;
        const finish = code => {
          clearTimeout(idleTimer);
          child.stdout.destroy();
          child.stderr.destroy();
          child.stdin.destroy();
          resolve(code ?? 128 + (constants.signals[child.signalCode] ?? 0));
        };
        const drain = () => {
          if (!exited) return;
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish(child.exitCode), 100);
        };
        child.stdout.on('data', drain);
        child.stderr.on('data', drain);
        child.once('error', reject);
        child.once('spawn', ready);
        child.once('close', finish);
        child.once('exit', () => { exited = true; drain(); });
      });
      if (signal?.aborted) throw new Error('aborted');
      if (timedOut) throw new Error(`timeout:${timeout}`);
      return { exitCode };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.processes.delete(terminalId);
    }
  }
}
