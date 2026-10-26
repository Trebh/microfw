import { SchemaAST } from "effect"

/** The `_tag` literals of a union of tagged structs; other shapes contribute none. */
const shapeTags = (type: SchemaAST.AST): ReadonlyArray<string> => {
  if (SchemaAST.isUnion(type)) return type.types.flatMap(shapeTags)
  if (!SchemaAST.isObjects(type)) return []
  const tag = type.propertySignatures.find((signature) => signature.name === "_tag")?.type
  return tag !== undefined && SchemaAST.isLiteral(tag) ? [String(tag.literal)] : []
}

/**
 * The tags a schema can carry on either side. A class (`Schema.TaggedClass`) is a declaration on
 * the type side and a struct only on the encoded side, so both are read.
 */
export const tagsOf = (ast: SchemaAST.AST): ReadonlyArray<string> => [
  ...shapeTags(SchemaAST.toType(ast)),
  ...shapeTags(SchemaAST.toEncoded(ast))
]
