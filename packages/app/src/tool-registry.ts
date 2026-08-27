import type { Tool, ToolContext, ToolPack } from "./tools.js";

/** Validates and composes statically registered tool packs. */
export class ToolRegistry {
  readonly #packs = new Map<string, ToolPack>();

  register(pack: ToolPack): void {
    const id = pack.id.trim();
    if (id === "") throw new Error("Tool pack id must not be empty");
    if (this.#packs.has(id)) throw new Error(`Duplicate tool pack: ${id}`);
    this.#packs.set(id, pack);
  }

  createTools(context: ToolContext): readonly Tool[] {
    const tools: Tool[] = [];
    const ownersByName = new Map<string, string>();

    for (const [packId, pack] of this.#packs) {
      const created = [...pack.create(context)];
      if (created.length === 0) throw new Error(`Tool pack ${packId} provides no tools`);

      for (const tool of created) {
        if (tool.metadata.ownerId !== packId) {
          throw new Error(
            `Tool pack ${packId} created ${tool.spec.name} owned by ${tool.metadata.ownerId}`,
          );
        }
        const existingOwner = ownersByName.get(tool.spec.name);
        if (existingOwner !== undefined) {
          throw new Error(
            `Duplicate tool ${tool.spec.name}: provided by ${existingOwner} and ${packId}`,
          );
        }
        for (const capability of tool.metadata.requiredCapabilities) {
          if (!context.capabilities.has(capability)) {
            throw new Error(`Tool ${tool.spec.name} requires capability ${capability}`);
          }
        }
        ownersByName.set(tool.spec.name, packId);
        tools.push(tool);
      }
    }

    return tools;
  }
}
