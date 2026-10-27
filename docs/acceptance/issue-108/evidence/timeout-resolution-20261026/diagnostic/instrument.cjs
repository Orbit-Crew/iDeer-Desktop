const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const meta = JSON.parse(fs.readFileSync('artifacts/issue-108/supplement/online-c-install.json','utf8'));
const program = path.resolve(meta.program);
if (!program.startsWith(path.resolve(os.tmpdir())+path.sep) || !path.basename(program).startsWith('ideer108-')) throw new Error('not an owned TEMP program');
const input = process.argv[2] === 'before' ? 'artifacts/issue-108/timeout/desktop-before.py' : 'local-runtime/core/desktop.py';
let source = fs.readFileSync(input,'utf8');
const hook = `
# Diagnostic-only observation barrier in this disposable installed copy.
_probe_load_controller = load_controller
def load_controller(*arguments, **keywords):
    controller = _probe_load_controller(*arguments, **keywords)
    original_status = controller.status
    def status_with_completion_barrier():
        import time
        if arguments:
            barrier = Path(arguments[0]).resolve().parents[3] / 'timing-barrier'
            arm = barrier / 'arm'
            if (arm.exists() and controller.client.install_draining
                    and controller.client.active_task_count() > 0):
                arm.unlink()
                (barrier / 'reached').write_text('ledger observed before real task completion')
                deadline = time.monotonic() + 20
                while controller.client.active_task_count() > 0 and time.monotonic() < deadline:
                    time.sleep(.005)
                (barrier / 'released').write_text(str(controller.client.active_task_count()))
        return original_status()
    controller.status = status_with_completion_barrier
    return controller

`;
const marker='def main() -> int:';
if(source.split(marker).length!==2)throw new Error('desktop entry changed');
source=source.replace(marker,hook+marker);
fs.writeFileSync(path.join(program,'resources/runtime/core/desktop.py'),source);
console.log(JSON.stringify({mode:process.argv[2],program,testOnly:true}));
