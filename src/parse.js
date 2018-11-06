import {/*getLineInfo,*/ tokTypes as tt, Parser} from "acorn";
import bigInt from "acorn-bigint";
// import constSafe from "./const-safe.js";
import dynamicImport from "./dynamic-import.js";
// import findReferences from "./references.js";

const SCOPE_FUNCTION = 2;
const SCOPE_ASYNC = 4;
const SCOPE_GENERATOR = 8;
const CellParser = Parser.extend(bigInt, dynamicImport, observable);

export function parseCell(input) {
  const cell = CellParser.parse(input);

  // // Empty?
  // if (cell.body === null) return cell;

  // // ImportExpression? import {node} from "module"
  // if (cell.body.type === "ImportDeclaration") return cell;

  // // Extract global references and compute their locations.
  // // Also check for illegal references to shadowed views.
  // try {
  //   cell.references = findReferences(cell);
  // } catch (node) {
  //   const {line, column} = getLineInfo(input, node.start);
  //   const keyword = node.type === "ViewExpression" ? "viewof" : "mutable";
  //   throw new ReferenceError(`${keyword} ${node.id.name} is not defined (${line}:${column})`);
  // }
  // for (const node of cell.references) {
  //   node.location = getLineInfo(input, node.start);
  // }

  // // Check for illegal references to arguments.
  // const argumentsReference = cell.references.find(isarguments);
  // if (argumentsReference) {
  //   const {line, column} = argumentsReference.location;
  //   throw new ReferenceError(`arguments is not allowed (${line}:${column})`);
  // }

  // // Check for illegal assignments to global references.
  // try {
  //   constSafe(cell);
  // } catch (node) {
  //   const {line, column} = getLineInfo(input, node.start);
  //   throw new TypeError(`Assignment to constant variable ${node.name} (${line}:${column})`);
  // }

  return cell;
}

// function isarguments({name}) {
//   return name === "arguments";
// }

function observable(Parser) {
  return class extends Parser {
    constructor(...options) {
      super(...options);
      this.O_function = 0;
      this.O_async = false;
      this.O_generator = false;
    }
    enterScope(flags) {
      if (flags & SCOPE_FUNCTION) ++this.O_function;
      return super.enterScope.apply(this, arguments);
    }
    exitScope() {
      if (this.currentScope() & SCOPE_FUNCTION) --this.O_function;
      return super.exitScope.apply(this, arguments);
    }
    parseForIn(node) {
      if (this.O_function === 1 && node.await) this.O_async = true;
      return super.parseForIn.apply(this, arguments);
    }
    parseAwait() {
      if (this.O_function === 1) this.O_async = true;
      return super.parseAwait.apply(this, arguments);
    }
    parseYield() {
      if (this.O_function === 1) this.O_generator = true;
      return super.parseYield.apply(this, arguments);
    }
    parseImport(node) {
      this.next();
      node.specifiers = this.parseImportSpecifiers();
      if (this.type === tt._with) {
        this.next();
        node.injections = this.parseImportSpecifiers();
      }
      this.expectContextual("from");
      node.source = this.type === tt.string ? this.parseExprAtom() : this.unexpected();
      return this.finishNode(node, "ImportDeclaration");
    }
    parseImportSpecifiers() {
      const nodes = [];
      let first = true;
      this.expect(tt.braceL);
      while (!this.eat(tt.braceR)) {
        if (first) {
          first = false;
        } else {
          this.expect(tt.comma);
          if (this.afterTrailingComma(tt.braceR)) break;
        }
        const node = this.startNode();
        node.view = this.eatContextual("viewof");
        if (!node.view) node.mutable = this.eatContextual("mutable");
        node.imported = this.parseIdent();
        if (this.eatContextual("as")) {
          node.local = this.parseIdent();
        } else {
          this.checkUnreserved(node.imported);
          node.local = node.imported;
        }
        this.checkLVal(node.local, "let");
        nodes.push(this.finishNode(node, "ImportSpecifier"));
      }
      return nodes;
    }
    parseExprAtom() {
      return this.parseMaybeKeywordExpression("viewof", "ViewExpression")
          || this.parseMaybeKeywordExpression("mutable", "MutableExpression")
          || super.parseExprAtom.apply(this, arguments);
    }
    parseTopLevel(node) {
      const lookahead = CellParser.tokenizer(this.input);
      let token = lookahead.getToken();
      let body = null;
      let id = null;

      this.strict = true;
      this.enterScope(SCOPE_FUNCTION | SCOPE_ASYNC | SCOPE_GENERATOR);

      // An import?
      if (token.type === tt._import) {
        body = this.parseImport(this.startNode());
      }

      // A non-empty cell?
      else if (token.type !== tt.eof) {

        // A named cell?
        if (token.type === tt.name) {
          if (token.value === "viewof" || token.value === "mutable") {
            token = lookahead.getToken();
            if (token.type !== tt.name) {
              lookahead.unexpected();
            }
          }
          token = lookahead.getToken();
          if (token.type === tt.eq) {
            id = this.parseMaybeKeywordExpression("viewof", "ViewExpression")
                || this.parseMaybeKeywordExpression("mutable", "MutableExpression")
                || this.parseIdent();
            token = lookahead.getToken();
            this.expect(tt.eq);
          }
        }

        // A block?
        if (token.type === tt.braceL) {
          body = this.parseBlock();
        }

        // An expression?
        // Possibly a function or class declaration?
        else {
          body = this.parseExpression();
          if (id === null && (body.type === "FunctionExpression" || body.type === "ClassExpression")) {
            id = body.id;
          }
        }
      }

      this.expect(tt.eof);
      node.id = id;
      node.async = this.O_async;
      node.generator = this.O_generator;
      node.body = body;
      return this.finishNode(node, "Cell");
    }
    toAssignable(node) {
      return node.type === "MutableExpression" ? node : super.toAssignable.apply(this, arguments);
    }
    checkUnreserved(node) {
      if (node.name ==="viewof" || node.name === "mutable") {
        this.raise(node.start, `Unexpected keyword '${node.name}'`);
      }
      return super.checkUnreserved(node);
    }
    checkLVal(expr, bindingType, checkClashes) {
      return expr.type === "MutableExpression"
          ? super.checkLVal.call(this, expr.id, bindingType, checkClashes)
          : super.checkLVal.apply(this, arguments);
    }
    unexpected(pos) {
      this.raise(pos != null ? pos : this.start, this.type === tt.eof ? "Unexpected end of input" : "Unexpected token");
    }
    parseMaybeKeywordExpression(keyword, type) {
      if (this.isContextual(keyword)) {
        const node = this.startNode();
        this.next();
        node.id = this.parseIdent();
        return this.finishNode(node, type);
      }
    }
  };
}