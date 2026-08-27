import { readFile } from "node:fs/promises";

import { activeContextEvents } from "@ant/core";
import type { Decision, HistoryEvent, ImageAttachment, Observation } from "@ant/core";
import { decisionMessage, observationContent } from "./protocol.js";
import type { DeepSeekContentPart, DeepSeekMessage } from "./protocol.js";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

async function imagePart(
  attachment: ImageAttachment,
  signal?: AbortSignal,
): Promise<DeepSeekContentPart> {
  signal?.throwIfAborted();
  const content = await readFile(attachment.path, { signal });
  if (content.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image ${attachment.path} exceeds the 32 MiB vision limit`);
  }
  return {
    type: "image_url",
    image_url: { url: `data:${attachment.mediaType};base64,${content.toString("base64")}` },
  };
}

export async function buildMessages(
  events: readonly HistoryEvent[],
  systemPrompt: string,
  includeReasoning: boolean,
  includeImages: boolean,
  signal?: AbortSignal,
): Promise<DeepSeekMessage[]> {
  const messages: DeepSeekMessage[] = [{ role: "system", content: systemPrompt }];
  let pending:
    | { decision: Extract<Decision, { type: "tools" }>; observations: Map<string, Observation> }
    | undefined;

  const flushPending = async (interrupted = false): Promise<void> => {
    if (!pending || (!interrupted && pending.observations.size !== pending.decision.calls.length)) {
      return;
    }

    messages.push(decisionMessage(pending.decision, includeReasoning));
    const attachments: ImageAttachment[] = [];
    for (const call of pending.decision.calls) {
      const observation = pending.observations.get(call.id) ?? {
        ok: false,
        error: "Tool call was interrupted; execution status is unknown",
      };
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: observationContent(observation),
      });
      attachments.push(...(observation.attachments ?? []));
    }

    if (attachments.length > 0 && includeImages) {
      let totalBytes = 0;
      const imageParts: DeepSeekContentPart[] = [];
      for (const attachment of attachments) {
        totalBytes += attachment.bytes;
        if (totalBytes > MAX_IMAGE_BYTES) {
          throw new Error("Image attachments exceed the 32 MiB request budget");
        }
        imageParts.push(await imagePart(attachment, signal));
      }
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "The preceding tool result includes image attachments. Inspect the images to answer the request.",
          },
          ...imageParts,
        ],
      });
    }
    pending = undefined;
  };

  for (const event of activeContextEvents(events)) {
    switch (event.type) {
      case "task":
      case "user":
        await flushPending(true);
        messages.push({ role: "user", content: event.content });
        break;
      case "decision":
        pending = undefined;
        if (event.decision.type === "tools") {
          pending = { decision: event.decision, observations: new Map() };
        } else {
          messages.push(decisionMessage(event.decision, includeReasoning));
        }
        break;
      case "compaction":
        pending = undefined;
        messages.push({
          role: "user",
          content: `Ниже дано резюме предыдущей части этой сессии. Используй его как контекст для продолжения работы.\n\n${event.summary}`,
        });
        break;
      case "verification":
        await flushPending(true);
        messages.push({
          role: "user",
          content: `[Самопроверка перед завершением хода, попытка ${event.round}/${event.maxRounds}]\n${event.feedback}`,
        });
        break;
      case "observation":
        if (pending && pending.decision.calls.some((call) => call.id === event.call.id)) {
          pending.observations.set(event.call.id, event.observation);
          await flushPending();
        }
        break;
    }
  }

  await flushPending(true);
  return messages;
}
