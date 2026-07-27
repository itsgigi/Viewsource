import * as babelParser from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { ImportRef, ParsedComponent, PropField } from "./types";

const HOOK_RE = /^use[A-Z0-9]/;
const TEST_FILE_RE = /\.(test|spec|stories)\.[jt]sx?$/;

export function isCandidateFile(relPath: string): boolean {
  if (!/\.(tsx|jsx|ts|js)$/.test(relPath)) return false;
  if (TEST_FILE_RE.test(relPath)) return false;
  return true;
}

/** Sorgente esatto della dichiarazione di un componente (per nome), usato per
 * lo snippet parziale del prompt gratuito (Fase 5) — non l'intero file, solo
 * la sua dichiarazione. Fallback sul default export se il nome non combacia
 * con nessun identificatore (default anonimo, displayName dal nome file). */
export function extractComponentSource(code: string, componentName: string): string | null {
  let ast: t.File;
  try {
    ast = babelParser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
      errorRecovery: true,
    });
  } catch {
    return null;
  }

  let byName: string | null = null;
  let defaultExportSpan: string | null = null;

  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name === componentName) byName = sliceNode(code, path.node);
    },
    VariableDeclarator(path) {
      if (t.isIdentifier(path.node.id) && path.node.id.name === componentName) {
        byName = sliceNode(code, path.node);
      }
    },
    ExportDefaultDeclaration(path) {
      defaultExportSpan = sliceNode(code, path.node);
    },
  });

  return byName ?? defaultExportSpan;
}

function sliceNode(code: string, node: t.Node): string | null {
  if (node.start == null || node.end == null) return null;
  return code.slice(node.start, node.end);
}

/** Solo gli import di un file — usato da dependencyGraph.ts per attraversare
 * file che non esportano un componente (hook, utility) senza rifare il parse completo. */
export function extractImports(code: string): ImportRef[] {
  let ast: t.File;
  try {
    ast = babelParser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
      errorRecovery: true,
    });
  } catch {
    return [];
  }

  const imports: ImportRef[] = [];
  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const isLocal = source.startsWith(".") || source.startsWith("/") || source.startsWith("@/");
      imports.push({ source, isLocal });
    },
  });
  return imports;
}

/**
 * Estrae i componenti React esportati da un singolo file: nome, props (da
 * interface/type TS o default di destructuring), import, hook usati, file
 * di stile associati, classi Tailwind presenti nel JSX. Deterministico,
 * nessuna chiamata LLM.
 */
export function parseFile(relPath: string, code: string): ParsedComponent[] {
  let ast: t.File;
  try {
    ast = babelParser.parse(code, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
      errorRecovery: true,
    });
  } catch {
    return []; // file non parsabile: salta, non bloccare la pipeline
  }

  const imports: ImportRef[] = [];
  const exportedNames = new Set<string>();
  let defaultExportName: string | null = null;
  const typeDecls = new Map<string, t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration>();
  const fnPaths = new Map<string, NodePath<t.Node>>();
  const styleFiles: string[] = [];

  traverse(ast, {
    ImportDeclaration(path) {
      const source = path.node.source.value;
      const isLocal = source.startsWith(".") || source.startsWith("/") || source.startsWith("@/");
      imports.push({ source, isLocal });
      if (/\.(css|scss|sass)(\?|$)/.test(source)) styleFiles.push(source);
    },
    TSInterfaceDeclaration(path) {
      typeDecls.set(path.node.id.name, path.node);
    },
    TSTypeAliasDeclaration(path) {
      typeDecls.set(path.node.id.name, path.node);
    },
    FunctionDeclaration(path) {
      if (path.node.id) fnPaths.set(path.node.id.name, path);
    },
    VariableDeclarator(path) {
      const init = path.node.init;
      if (t.isIdentifier(path.node.id) && (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init))) {
        fnPaths.set(path.node.id.name, path.get("init") as NodePath<t.Node>);
      }
    },
    ExportNamedDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isFunctionDeclaration(decl) && decl.id) exportedNames.add(decl.id.name);
      if (t.isVariableDeclaration(decl)) {
        for (const d of decl.declarations) {
          if (t.isIdentifier(d.id)) exportedNames.add(d.id.name);
        }
      }
      for (const spec of path.node.specifiers) {
        if (t.isExportSpecifier(spec) && t.isIdentifier(spec.exported)) {
          exportedNames.add(spec.exported.name);
        }
      }
    },
    ExportDefaultDeclaration(path) {
      const decl = path.node.declaration;
      if (t.isIdentifier(decl)) {
        defaultExportName = decl.name;
      } else if (t.isFunctionDeclaration(decl) && decl.id) {
        defaultExportName = decl.id.name;
        fnPaths.set(decl.id.name, path.get("declaration") as NodePath<t.Node>);
      } else if (t.isFunctionDeclaration(decl) || t.isArrowFunctionExpression(decl)) {
        // export default function() {...} anonima: usa il nome del file
        defaultExportName = "__default__";
        fnPaths.set("__default__", path.get("declaration") as NodePath<t.Node>);
      }
    },
  });

  const components: ParsedComponent[] = [];
  const seen = new Set<string>();
  const candidateNames = new Set<string>(exportedNames);
  if (defaultExportName) candidateNames.add(defaultExportName);

  for (const name of candidateNames) {
    if (seen.has(name)) continue;
    const fnPath = fnPaths.get(name);
    if (!fnPath || !isFunctionNode(fnPath.node)) continue;
    if (!isComponentName(name)) continue;

    const analysis = analyzeFunction(fnPath as NodePath<t.Function>);
    if (!analysis.returnsJsx) continue;
    seen.add(name);

    const displayName = name === "__default__" ? fileBaseComponentName(relPath) : name;

    components.push({
      name: displayName,
      filePath: relPath,
      isDefaultExport: name === defaultExportName,
      props: extractProps(fnPath.node as t.Function, typeDecls),
      imports,
      hooks: analysis.hooks,
      styleFiles,
      tailwindClasses: analysis.tailwindClasses,
    });
  }

  return components;
}

function isFunctionNode(node: t.Node): node is t.Function {
  return (
    t.isFunctionDeclaration(node) || t.isArrowFunctionExpression(node) || t.isFunctionExpression(node)
  );
}

function isComponentName(name: string): boolean {
  if (name === "__default__") return true;
  return /^[A-Z]/.test(name);
}

function fileBaseComponentName(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  const noExt = base.replace(/\.(tsx|jsx|ts|js)$/, "");
  return noExt === "index" ? (relPath.split("/").slice(-2, -1)[0] ?? "Component") : noExt;
}

interface FunctionAnalysis {
  returnsJsx: boolean;
  hooks: string[];
  tailwindClasses: string[];
}

/** Un solo `path.traverse()` sui discendenti già collegati all'albero attivo:
 * sicuro (a differenza di ri-traversare un nodo isolato senza scope/parentPath). */
function analyzeFunction(fnPath: NodePath<t.Function>): FunctionAnalysis {
  const node = fnPath.node;
  const hooks = new Set<string>();
  const classes = new Set<string>();
  let returnsJsx = false;

  if (t.isArrowFunctionExpression(node) && !t.isBlockStatement(node.body)) {
    returnsJsx = isJsxLike(node.body);
  }

  fnPath.traverse({
    ReturnStatement(path) {
      if (path.node.argument && isJsxLike(path.node.argument)) returnsJsx = true;
    },
    CallExpression(path) {
      const callee = path.node.callee;
      if (t.isIdentifier(callee) && HOOK_RE.test(callee.name)) hooks.add(callee.name);
    },
    JSXAttribute(path) {
      if (!t.isJSXIdentifier(path.node.name) || path.node.name.name !== "className") return;
      const value = path.node.value;
      let text: string | null = null;
      if (t.isStringLiteral(value)) text = value.value;
      if (t.isJSXExpressionContainer(value) && t.isStringLiteral(value.expression)) {
        text = value.expression.value;
      }
      if (t.isJSXExpressionContainer(value) && t.isTemplateLiteral(value.expression)) {
        text = value.expression.quasis.map((q) => q.value.raw).join(" ");
      }
      if (text) {
        for (const cls of text.split(/\s+/).filter(Boolean)) classes.add(cls);
      }
    },
  });

  return { returnsJsx, hooks: Array.from(hooks), tailwindClasses: Array.from(classes).slice(0, 60) };
}

function isJsxLike(node: t.Node): boolean {
  if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
  if (t.isParenthesizedExpression(node)) return isJsxLike(node.expression);
  if (t.isConditionalExpression(node)) return isJsxLike(node.consequent) || isJsxLike(node.alternate);
  if (t.isLogicalExpression(node)) return isJsxLike(node.right);
  return false;
}

function extractProps(
  fn: t.Function,
  typeDecls: Map<string, t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration>
): PropField[] {
  const param = fn.params[0];
  if (!param) return [];

  // Caso 1: parametro tipizzato con un'interface/type dichiarata nello stesso file.
  const typeName = paramTypeName(param);
  if (typeName && typeDecls.has(typeName)) {
    return fieldsFromTypeDecl(typeDecls.get(typeName)!);
  }

  // Caso 2: annotazione inline { a: string; b?: number }
  const annotation = t.isIdentifier(param) || t.isObjectPattern(param) ? param.typeAnnotation : null;
  if (annotation && t.isTSTypeAnnotation(annotation) && t.isTSTypeLiteral(annotation.typeAnnotation)) {
    return fieldsFromTypeLiteral(annotation.typeAnnotation);
  }

  // Caso 3: nessun tipo, ma destructuring con default — es. ({ title = "x" })
  if (t.isObjectPattern(param)) {
    return fieldsFromObjectPattern(param);
  }

  return [];
}

function paramTypeName(param: t.Node): string | null {
  const annotation = (param as t.Identifier | t.ObjectPattern).typeAnnotation;
  if (annotation && t.isTSTypeAnnotation(annotation) && t.isTSTypeReference(annotation.typeAnnotation)) {
    const typeName = annotation.typeAnnotation.typeName;
    if (t.isIdentifier(typeName)) return typeName.name;
  }
  return null;
}

function fieldsFromTypeDecl(
  decl: t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration
): PropField[] {
  if (t.isTSInterfaceDeclaration(decl)) {
    return decl.body.body.flatMap(memberToField);
  }
  if (t.isTSTypeAliasDeclaration(decl) && t.isTSTypeLiteral(decl.typeAnnotation)) {
    return fieldsFromTypeLiteral(decl.typeAnnotation);
  }
  return [];
}

function fieldsFromTypeLiteral(lit: t.TSTypeLiteral): PropField[] {
  return lit.members.flatMap(memberToField);
}

function memberToField(member: t.TSTypeElement): PropField[] {
  if (!t.isTSPropertySignature(member) || !t.isIdentifier(member.key)) return [];
  return [
    {
      name: member.key.name,
      type: member.typeAnnotation ? typeNodeToString(member.typeAnnotation.typeAnnotation) : "unknown",
      optional: !!member.optional,
    },
  ];
}

function fieldsFromObjectPattern(pattern: t.ObjectPattern): PropField[] {
  const fields: PropField[] = [];
  for (const prop of pattern.properties) {
    if (!t.isObjectProperty(prop)) continue;
    const key = prop.key;
    if (!t.isIdentifier(key)) continue;
    const value = prop.value;
    if (t.isAssignmentPattern(value)) {
      fields.push({
        name: key.name,
        type: "unknown",
        optional: true,
        defaultValue: defaultValueToString(value.right),
      });
    } else {
      fields.push({ name: key.name, type: "unknown", optional: false });
    }
  }
  return fields;
}

function defaultValueToString(node: t.Node): string {
  if (t.isStringLiteral(node)) return JSON.stringify(node.value);
  if (t.isNumericLiteral(node)) return String(node.value);
  if (t.isBooleanLiteral(node)) return String(node.value);
  if (t.isNullLiteral(node)) return "null";
  if (t.isArrayExpression(node)) return "[]";
  if (t.isObjectExpression(node)) return "{}";
  return "…";
}

function typeNodeToString(node: t.TSType): string {
  if (t.isTSStringKeyword(node)) return "string";
  if (t.isTSNumberKeyword(node)) return "number";
  if (t.isTSBooleanKeyword(node)) return "boolean";
  if (t.isTSTypeReference(node) && t.isIdentifier(node.typeName)) return node.typeName.name;
  if (t.isTSUnionType(node)) return node.types.map(typeNodeToString).join(" | ");
  if (t.isTSArrayType(node)) return `${typeNodeToString(node.elementType)}[]`;
  if (t.isTSFunctionType(node)) return "function";
  if (t.isTSLiteralType(node) && t.isStringLiteral(node.literal)) return JSON.stringify(node.literal.value);
  return "unknown";
}
