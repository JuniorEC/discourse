let idx = 0;

function newAcc() {
  return `_acc${idx++}`;
}

function resolve(path) {
  return (path.indexOf('settings') === 0) ? `this.${path}` : path;
}

function processNode(parentAcc, node) {
  let instructions = [];
  let innerAcc;

  switch(node.type) {
    case "Program":
      node.body.forEach(bodyNode => {
        instructions = instructions.concat(processNode(parentAcc, bodyNode));
      });
      break;
    case "ElementNode":
      innerAcc = newAcc();
      instructions.push(`var ${innerAcc} = []`);
      node.children.forEach(child => {
        instructions = instructions.concat(processNode(innerAcc, child));
      });

      if (node.attributes.length) {
        const attributes = {};
        node.attributes.forEach(a => {
          attributes[a.name === 'class' ? 'className' : a.name] = a.value.chars;
        });

        instructions.push(`${parentAcc}.push(virtualDom.h('${node.tag}', ${JSON.stringify(attributes)}, ${innerAcc}))`);
      } else {
        instructions.push(`${parentAcc}.push(virtualDom.h('${node.tag}', ${innerAcc}))`);
      }

      break;

    case "TextNode":
      return `${parentAcc}.push(${JSON.stringify(node.chars)})`;

    case "MustacheStatement":
      let path = node.path.original;

      switch(path) {
        case 'attach':
          const widgetName = node.hash.pairs.find(p => p.key === "widget").value.value;
          instructions.push(`${parentAcc}.push(this.attach("${widgetName}", attrs, state))`);
          break;
        case 'yield':
          instructions.push(`${parentAcc}.push(this.attrs.contents());`);
          break;
        default:
          instructions.push(`${parentAcc}.push(${resolve(path)})`);
          break;
      }

      break;
    case "BlockStatement":
      if (node.path.original === "if") {
        innerAcc = newAcc();
        instructions.push(`var ${innerAcc} = []`);
        instructions.push(`if (${node.params[0].original}) {`);
        node.program.body.forEach(child => {
          instructions = instructions.concat(processNode(innerAcc, child));
        });
        if (innerAcc.length > 0) {
          instructions.push(`${parentAcc}.push(${innerAcc})`);
        }

        if (node.inverse) {
          instructions.push(`} else {`);
          node.inverse.body.forEach(child => {
            instructions = instructions.concat(processNode(innerAcc, child));
          });
          if (innerAcc.length > 0) {
            instructions.push(`${parentAcc}.push(${innerAcc})`);
          }
        }
        instructions.push(`}`);
      }

      break;
    default:
      break;
  }

  return instructions.join("\n");
}

function compile(template) {
  const syntax = Ember.__loader.require('@glimmer/syntax');
  const compiled = syntax.preprocess(template);
  return `var _result = [];\n${processNode('_result', compiled)}\nreturn _result;`;
}

function error(path, state, msg) {
  const filename = state.file.opts.filename;
  return path.replaceWithSourceString(`function() { console.error("${filename}: ${msg}"); }`);
}

function WidgetHbsCompiler(babel) {
  let t = babel.types;
  return {
    visitor: {
      ImportDeclaration(path, state) {
        let node = path.node;
        if (t.isLiteral(node.source, { value: "discourse/widgets/hbs-compiler" })) {
          let first = node.specifiers && node.specifiers[0];
          if (!t.isImportDefaultSpecifier(first)) {
            let input = state.file.code;
            let usedImportStatement = input.slice(node.start, node.end);
            let msg = `Only \`import hbs from 'discourse/widgets/hbs-compiler'\` is supported. You used: \`${usedImportStatement}\``;
            throw path.buildCodeFrameError(msg);
          }

          state.importId = state.importId || path.scope.generateUidIdentifierBasedOnNode(path.node.id);
          path.scope.rename(first.local.name, state.importId.name);
          path.remove();
        }
      },

      TaggedTemplateExpression(path, state) {
        if (!state.importId) { return; }

        let tagPath = path.get('tag');
        if (tagPath.node.name !== state.importId.name) {
          return;
        }

        if (path.node.quasi.expressions.length) {
          return error(path, state, "placeholders inside a tagged template string are not supported");
        }

        let template = path.node.quasi.quasis.map(quasi => quasi.value.cooked).join('');

        try {
          const compiled = compile(template);
          path.replaceWithSourceString(`function(attrs, state) { ${compiled} }`);
        } catch(e) {
          return error(path, state, e.toString());
        }

      }
    }
  };
};
