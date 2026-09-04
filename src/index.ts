/**
 * Subagent steer (`steer_subagent`): deliver a parent's new instruction INTO a
 * running background subagent's current turn, instead of queueing it behind
 * the turn.
 *
 * DSH's global `send_message` tool always enqueues through
 * `ctx.subagents.followup()`: the child finishes its entire current
 * instruction before reading the next message. The agent runtime itself has a
 * gentler primitive — `Agent.steer()` inserts at the NEXT-STEP position of the
 * inbox, so a busy child reads the message at its next step boundary and an
 * idle one is woken into a normal turn; this is the same mechanism the
 * continuation service uses to deliver settlement notices to busy parents.
 * This plugin exposes that primitive as a model tool, alongside a hard mode
 * that combines `ctx.subagents.interrupt()` (a keepInbox cancel of the current
 * turn) with a waking followup delivery.
 *
 * Delivery matrix (route decided from live residency + requested mode):
 * - mode 'turn'                  -> stop the current turn, deliver as fresh turn
 * - live + running, mode 'step'  -> Agent.steer() into the current turn
 * - live + idle,    mode 'step'  -> followup() wake (same path as send_message)
 * - not live,       any mode     -> followup() cold-resume (same path as send_message)
 *
 * Authorization mirrors the subagent service's own parent checks: only the
 * exact live direct parent may steer, proven by the child session header
 * (`parentSession === caller.id` and `origin === 'subagent'`); the interrupt
 * path goes through the service's ancestor authority instead.
 *
 * Validated end to end 2026-08-30 in creation mode (dynamic plugin steer-1):
 * a 12-step counting child steered at ~step 3 quoted the inserted instruction
 * verbatim, completed exactly steps 1-3, and never ran steps 4-12; an
 * unsteered control child ran all 12 steps.
 *
 * Known limitations (documented in the tool description and design overview):
 * - the steer itself takes effect immediately, but the child's replies and
 *   settlement notice still arrive through the normal cross-turn delivery;
 * - a one-shot child that settles before claiming the steered message drops
 *   it with its inbox on disposal — steer targets should be continuable
 *   children.
 * @module @momojie-s/dsh-subagent-steer
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'dsh-subagent-steer'
/** `tools` registers the model tool; `agents` resolves the live child; `subagents` owns followup/interrupt. */
export const inject = ['tools', 'subagents', 'agents']

/** Config: tool naming knob (multi-instance deployments must use distinct names). */
export interface Config {
  /** Model-facing tool name (default `steer_subagent`). */
  toolName?: string
}

export const Config: z<Config> = z.object({
  toolName: z.string().default('steer_subagent'),
})

/** Which delivery path one steer call took; surfaces in the tool result. */
export type SteerRoute = 'step' | 'turn' | 'wakeup' | 'cold-resume'

/**
 * Decide the delivery route from the requested mode and the target's live
 * residency. Pure so the routing contract is unit-testable without Cordis.
 * @param mode - requested `mode` argument ('step' | 'turn'; anything else reads as 'step').
 * @param live - whether the target Agent is currently in the live registry.
 * @param running - whether that live Agent is mid-turn (status 'running').
 */
export function resolveRoute(mode: string | undefined, live: boolean, running: boolean): SteerRoute {
  if (mode === 'turn') return 'turn'
  if (!live) return 'cold-resume'
  return running ? 'step' : 'wakeup'
}

/**
 * Build the model-facing tool description. Kept pure and exported so tests can
 * guard the contract that matters most: the description must teach the model
 * how this tool differs from the stock `send_message` queue and the bare
 * `interrupt_agent` stop.
 */
export function buildToolDescription(): string {
  return 'Deliver a new instruction to a background subagent by its subagent id, with control over how '
    + 'immediately it takes effect. Unlike `send_message` — which always queues the message as a LATER turn, '
    + 'so the subagent first finishes its entire current instruction before even reading the new one — this '
    + 'tool can deliver INTO the current turn. By default (mode \'step\') the message joins the subagent\'s '
    + 'running turn at its next step boundary: the subagent reads it before its next model step, work already '
    + 'completed is kept, and nothing waits behind the whole turn. Use `send_message` for additional work that '
    + 'can safely wait its turn; use this tool when you need to correct, refocus, or redirect work that is '
    + 'underway right now. Modes: omit `mode` or pass \'step\' for the gentle insert described above. Pass '
    + 'mode \'turn\' for a hard redirect: the subagent\'s current turn is stopped first (its partial work in '
    + 'that turn is discarded; already-queued messages stay parked) and the message starts a fresh turn — '
    + 'equivalent to `interrupt_agent` followed by a delivery. If the target is idle or only in storage, both '
    + 'modes fall back to the normal delivery path (wake or cold-resume) with the same FIFO guarantees as '
    + '`send_message`. Only direct background subagent children of the calling agent can be steered; deeper '
    + 'descendants are candidates for `interrupt_agent` only. This call returns delivery confirmation, not the '
    + 'subagent\'s answer — replies and the settlement notice still arrive through the normal cross-turn '
    + 'delivery. A failure means the message was NOT delivered.'
}

/**
 * Human/model-facing one-line result text for one delivery route.
 */
export function renderSteer(route: SteerRoute, subagentId: string): string {
  switch (route) {
    case 'step':
      return `instruction inserted into the current turn of subagent ${subagentId} (takes effect at its next step boundary)`
    case 'turn':
      return `current turn of subagent ${subagentId} interrupted; message delivered as its fresh turn`
    case 'cold-resume':
      return `subagent ${subagentId} was not live; message delivered via cold resume (queued as its next turn)`
    case 'wakeup':
      return `subagent ${subagentId} was idle; message delivered as its next turn (wakeup sent)`
  }
}

/** The message source stamped onto steered and followup deliveries — identical to `send_message`'s. */
function relaySource(caller: Agent) {
  return { kind: 'coordinator' as const, form: 'relay' as const, senderSessionId: caller.id }
}

/**
 * Register the steer tool.
 * @param ctx - context carrying the tool registry, subagent service, and agent registry.
 * @param config - resolved plugin config (tool naming).
 */
export function apply(ctx: Context, config: Config): void {
  const toolName = config.toolName ?? 'steer_subagent'
  ctx.tools.register(defineTool({
    name: toolName,
    description: buildToolDescription(),
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The instruction to deliver to the subagent.',
      },
      mode: {
        type: 'string',
        description: '\'step\' (default): insert into the running turn at the next step boundary, keeping work '
          + 'already done. \'turn\': stop the current turn first (its partial work is lost; already-queued '
          + 'messages stay parked) and deliver the message as a fresh turn. Omit for the default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          route: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: renderSteer((value?.route ?? 'wakeup') as SteerRoute, args.subagent_id),
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Parent authority requires an exact live calling agent.
        throw new Error(`${config.toolName} requires a calling agent (exec.agent was undefined)`)
      }
      const childId = args.subagent_id
      if (!childId || childId === caller.id) {
        throw new Error(`${config.toolName} needs the subagent id of another background subagent`)
      }
      const content: ContentBlock[] = [{ type: 'text', text: args.message }]
      const target = ctx.agents.get(SessionId(childId))
      const route = resolveRoute(args.mode, target !== undefined, target?.status === 'running')

      if (route === 'turn') {
        // Hard redirect: the service authorizes the exact live ancestor and
        // cancels the current turn with keepInbox; an absent or settled target
        // is an accepted no-op. The waking followup then delivers the message.
        ctx.subagents.interrupt(SessionId(childId), { kind: 'ancestor', agent: caller })
        const messageId = await ctx.subagents.followup(caller, SessionId(childId), content, {
          source: relaySource(caller),
          signal: exec.signal,
        })
        return { route, messageId: String(messageId) }
      }

      if (route === 'step') {
        // Gentle insert into the live, mid-turn child. The service has no
        // steer-shaped API, so the parent check mirrors the service's own
        // 'user'-authority rule: the exact durable direct parent, and only a
        // session-backed subagent child.
        const targetAgent = target as Agent
        const header = targetAgent.session.header
        if (header.parentSession !== caller.id || header.origin !== 'subagent') {
          throw new Error(`subagent "${childId}" is not a live direct subagent child of the calling agent`)
        }
        targetAgent.steer(createUserMessage({ content, source: relaySource(caller) }))
        return { route, messageId: '' }
      }

      // Idle or cold: the service-owned path already handles wakeup and
      // cold-resume with send_message's FIFO guarantees.
      const messageId = await ctx.subagents.followup(caller, SessionId(childId), content, {
        source: relaySource(caller),
        signal: exec.signal,
      })
      return { route, messageId: String(messageId) }
    },
  }))
}
