import type { Entity } from "../types.js";

/**
 * Entity co-occurrence is a reader-visible claim: an entity may appear in the graph only when
 * its exact stored name is actually present in the final reader-visible statement. ASCII names
 * additionally need alphanumeric token boundaries (`AI` is not mentioned by `FAIR`). This is
 * intentionally not translation, alias expansion, or fuzzy NER; uncertainty must remove a graph
 * edge rather than invent a relationship that the statement and its bound quote do not show.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function statementMentionsEntity(statement: string, name: string): boolean {
  if (!/^[\x20-\x7E]+$/u.test(name) || !/[A-Za-z0-9]/u.test(name)) return statement.includes(name);
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegex(name)}(?=$|[^a-z0-9])`, "iu").test(statement);
}

export function entitiesMentionedInStatement(statement: string, entities: readonly Entity[] | undefined): Entity[] {
  return (entities ?? []).filter((entity) => {
    const name = entity.name?.trim();
    return Boolean(name && statementMentionsEntity(statement, name));
  });
}
