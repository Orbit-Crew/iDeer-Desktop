// Issue 113: the branch semantics (#78) shared by the conversation and the
// Synapse session map. The map reads the same gate the conversation renders
// off the same read-only state snapshot, so a node only offers 从此分支 when
// the conversation itself could branch — one vocabulary, no drift. Keep in
// step with ChatContents' settled/unreachable/pending composition; the
// chat-branch tests pin both surfaces.
import type { ChatSnapshot } from './desktop'

/** Issue 78: the platform branches from one completed assistant turn, so the
 * command carries the whole turn's assistant message ids. This groups the
 * transcript exactly that way — the consecutive Agent messages between two
 * human messages; tool messages belong to the turn but never enter the id
 * group, and no other grouping exists anywhere on the device. */
export const turnGroups = (messages: ChatSnapshot['messages']): Map<string, string[]> => {
  const groups = new Map<string, string[]>()
  let turn: string[] = []
  const settle = (): void => {
    if (turn.length) {
      for (const id of turn) groups.set(id, turn)
      turn = []
    }
  }
  for (const message of messages) {
    if (message.role === 'human') settle()
    else if (message.role === 'ai') turn = [...turn, message.id]
  }
  settle()
  return groups
}

/** Issue 78: a branch needs a settled session — no in-flight run, no stream;
 * it additionally refuses an open clarification, and Issue 80's observed
 * unreachable platform pauses it by name. The Server and the Runtime
 * re-check and stay authoritative; this gate only decides what the UI
 * offers. */
export const branchGate = (state: Pick<ChatSnapshot, 'thread' | 'stream' | 'run' | 'platform' | 'messages'>, busy = false): boolean => {
  if (!state.thread?.id) return false
  if (busy || state.stream !== 'idle') return false
  if (['pending', 'running'].includes(state.run?.status || '')) return false
  if (state.platform?.reachable === false) return false
  const answered = new Set(state.messages.flatMap((m) => m.response ? [m.response.request_id] : []))
  return !state.messages.some((m) => m.request && !answered.has(m.request.request_id))
}
