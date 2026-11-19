const { spawn } = require('node:child_process');

const child = spawn(process.argv[2], [process.argv[3], '--nested-main'], {
  stdio: 'inherit', windowsHide: true
});
child.on('exit', code => process.exit(code ?? 1));
