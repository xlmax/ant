import * as ts from "typescript";

export interface ModuleReference {
  /** Undefined means a non-literal dynamic import that cannot be checked statically. */
  specifier: string | undefined;
  runtime: boolean;
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  // With verbatimModuleSyntax, `import { type X }` emits `import {}` and still
  // evaluates the target module. Only declaration-level `import type` vanishes.
  return clause?.isTypeOnly !== true;
}

function exportDeclarationHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  // Likewise, `export { type X } from ...` emits `export {} from ...`.
  return !node.isTypeOnly;
}

/** Extracts module references from real TypeScript syntax, never comments or strings. */
export function parseModuleReferences(source: string, fileName = "module.ts"): ModuleReference[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const references: ModuleReference[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier !== undefined) {
        references.push({
          specifier,
          runtime: importClauseHasRuntimeValue(node.importClause),
        });
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = stringLiteral(node.moduleSpecifier);
      if (specifier !== undefined) {
        references.push({ specifier, runtime: exportDeclarationHasRuntimeValue(node) });
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        const specifier = stringLiteral(reference.expression);
        if (specifier !== undefined) {
          references.push({ specifier, runtime: !node.isTypeOnly });
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument)
        ? stringLiteral(node.argument.literal)
        : undefined;
      if (specifier !== undefined) references.push({ specifier, runtime: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      references.push({ specifier: stringLiteral(node.arguments[0]), runtime: true });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}
