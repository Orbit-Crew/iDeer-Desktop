// Issue 110: the close-ask card (decision #59.4). One shared confirmation for
// every path that would end a live human-terminal program by removing its
// pane: pane close, tab close, and layout-preset replacement. "保留程序"
// cancels the close entirely; "结束程序并关闭" kills the sessions and
// performs the close the user asked for.
import { Modal } from 'antd'
import { useCloseGuardStore } from './closeGuard'

export default function TerminalCloseConfirm(): JSX.Element {
  const pending = useCloseGuardStore((s) => s.pending)
  const confirm = useCloseGuardStore((s) => s.confirm)
  const cancel = useCloseGuardStore((s) => s.cancel)
  return (
    <Modal
      open={pending !== null}
      title="结束终端中的程序？"
      okText="结束程序并关闭"
      cancelText="保留程序"
      onOk={confirm}
      onCancel={cancel}
      width={440}
      zIndex={200}
    >
      <div className="text-sm text-gray-600 leading-relaxed">
        人工终端窗格中仍有正在运行的程序。关闭将结束它们；选择「保留程序」则什么都不做，窗格保持原样。
      </div>
    </Modal>
  )
}
