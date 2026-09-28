export async function resolveItemFromDropEvent(event) {
    const TE = globalThis.foundry?.applications?.ux?.TextEditor ?? globalThis.TextEditor;
    let data = null;
    if (typeof TE?.getDragEventData === "function") {
        data = TE.getDragEventData(event);
    } else if (TE?.implementation && typeof TE.implementation.getDragEventData === "function") {
        data = TE.implementation.getDragEventData(event);
    }
    if (!data?.type) {
        try {
            data = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}");
        } catch {
            data = null;
        }
    }
    if (!data || data.type !== "Item") return null;
    if (data.uuid && typeof fromUuid === "function") {
        try {
            const doc = await fromUuid(data.uuid);
            if (doc) return doc;
        } catch {
            /* fall through */
        }
    }
    if (typeof Item?.implementation?.fromDropData === "function") {
        try {
            const doc = await Item.implementation.fromDropData(data);
            return doc || null;
        } catch {
            return null;
        }
    }
    return null;
}
