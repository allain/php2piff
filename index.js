const Engine = require('php-parser')
const Lazy = require('lazy.js')
const format = require('./lib/format.js')
const flatten = require('flatten')

const parser = new Engine({
  parser: {
    extractDoc: true
  },
  ast: {
    withPositions: true
  }
})

const addSlashes = str => {
  let result = JSON.stringify(str)
  return result.substr(1, result.length - 2)
}

const args = args => ['(', args ? inject(args.map(piff), ',') : null, ')']

const inject = (arr, delim) => {
  let result = arr.reduce((result, item) => {
    result.push(item)
    result.push(delim)
    return result
  }, [])
  if (arr.length) {
    result.pop()
  }
  return result
}

let generators = {
  program: n => inject(n.children.map(piff), ['\n', '\n']),
  inline: n => ['print', '(', '"' + addSlashes(n.value) + '"', ')'],
  class: n => [
    'class',
    ' ',
    n.name,
    ' ',
    n.extends ? ['extends', ' ', piff(n.extends), ' '] : null,
    n.implements
      ? ['implements', ' ', inject(n.implements.map(piff), [',', ' ']), ' ']
      : null,
    '{',
    n.body ? inject(n.body.map(piff), '\n') : null,
    '}'
  ],
  identifier: n => n.name,
  method: n => [
    '\n',
    n.visibility && n.visibility != 'public' ? [n.visibility, ' '] : null,
    n.isStatic ? ['static', ' '] : null,
    n.name,
    args(n.arguments),
    piff(n.body)
  ],
  classconstant: n => [n.name, '=', piff(n.value)],
  property: n => [
    n.visibility && n.visiblity !== 'public' ? [n.visibility, ' '] : null,
    n.isStatic ? ['static', ' '] : null,
    n.name,
    n.value ? ['=', piff(n.value)] : null
  ],
  parameter: n => {
    let type = n.type
      ? flatten([piff(n.type)]).join('').replace(/^\\([a-z])/, '$1')
      : null
    return [
      n.type ? [type, ' '] : null,
      n.name,
      n.value ? ['=', piff(n.value)] : null
    ]
  },
  block: n => ['{', inject(n.children.map(piff), '\n'), '}'],
  constref: n => [typeof n.name === 'string' ? n.name : piff(n.name)],
  return: n => ['return', n.expr ? [' ', piff(n.expr)] : null],
  variable: n => n.name,
  number: n => n.value,
  string: n => [
    n.isDoubleQuote
      ? JSON.stringify(n.value)
      : "'" + addSlashes(n.value).replace("'", "'") + "'"
  ],
  function: n => ['fn', ' ', n.name, args(n.arguments), piff(n.body)],
  assign: n => {
    let operator = typeof n.operator === 'string' ? n.operator : '='
    if (operator === '.=') {
      return [
        piff(n.left),
        '=',
        '"',
        '"',
        '+',
        piff(n.left),
        '+',
        piff(n.right)
      ]
    }
    return [piff(n.left), ' ', operator, ' ', piff(n.right)]
  },
  closure: n => ['fn', ' ', args(n.arguments), piff(n.body)],
  bin: n => {
    let left = flatten([piff(n.left)])
    let right = flatten([piff(n.right)])
    if (n.type === '.') {
      if (left[0][0].match(/^['"]/) || right[0][0].match(/^['"]/)) {
        return [left, '+', right]
      } else {
        return ['""', '+', left, '+', right]
      }
    } else {
      return [left, ' ', n.type, ' ', right]
    }
  },
  parenthesis: n => ['(', piff(n.inner), ')'],
  boolean: n => (n.value ? 'true' : 'false'),
  array: n => ['[', inject(n.items.map(piff), ','), ']'],
  entry: n => {
    if (n.key) {
      let keyVal = piff(n.key).join('')
      if (/^['"'][A-Za-z_]+['"]$/.test(keyVal)) {
        return [keyVal.substr(1, keyVal.length - 2), ':', piff(n.value)]
      } else {
        return [keyVal, ':', piff(n.value)]
      }
    }
    return piff(n.value)
  },
  call: n => [piff(n.what), args(n.arguments)],
  staticlookup: n => {
    let what = piff(n.what)

    return what === 'self'
      ? ['@@', piff(n.offset)]
      : [what, '::', piff(n.offset)]
  },
  propertylookup: n => {
    let toThis = n.what.kind === 'variable' && n.what.name === 'this'
    return [
      toThis ? ['@', piff(n.offset)] : [piff(n.what), '.', piff(n.offset)]
    ]
  },
  foreach: n => [
    'foreach',
    ' ',
    '(',
    piff(n.source),
    ' ',
    'as',
    ' ',
    n.key ? [piff(n.key), '=>'] : null,
    piff(n.value),
    ')',
    piff(n.body)
  ],
  if: n => [
    'if',
    ' ',
    '(',
    piff(n.test),
    ')',
    piff(n.body),
    n.alternate ? [' ', 'else', ' ', piff(n.alternate)] : null
  ],
  unary: n => [n.type, piff(n.what)],
  pre: n => {
    let pre = {
      '+': '++',
      '-': '--'
    }[n.type]

    return [pre, piff(n.what)]
  },
  post: n => {
    let post = {
      '+': '++',
      '-': '--'
    }[n.type]

    return [piff(n.what), post]
  },
  encapsed: n => {
    return flatten([
      '"',
      n.value.map(
        v => (v.kind === 'string' ? addSlashes(v.value) : ['{', piff(v), '}'])
      ),
      '"'
    ]).join('')
  },
  continue: n => 'continue',
  try: n => ['try', ' ', piff(n.body), n.catches.map(piff)],
  catch: n => [
    'catch',
    ' ',
    '(',
    piff(n.what[0]),
    ' ',
    piff(n.variable),
    ')',
    piff(n.body)
  ],
  throw: n => ['throw', ' ', piff(n.what)],
  new: n => ['new', ' ', piff(n.what), args(n.arguments)],
  offsetlookup: n => [piff(n.what), '[', n.offset ? piff(n.offset) : null, ']'],
  isset: n => ['isset', args(n.arguments)],
  unset: n => ['unset', args(n.arguments)],
  retif: n => {
    if (
      !n.trueExpr // ?: syntax
    ) {
      return [piff(n.test), '||', piff(n.falseExpr)]
    }

    return [
      piff(n.test),
      ' ',
      '?',
      ' ',
      piff(n.trueExpr),
      ' ',
      ':',
      ' ',
      piff(n.falseExpr)
    ]
  },
  echo: n => ['echo', args(n.arguments)],
  for: n => [
    'for',
    ' ',
    flatten([
      '(',
      inject(n.init.map(piff), ','),
      '; ',
      inject(n.test.map(piff), ','),
      '; ',
      inject(n.increment.map(piff), ','),
      ')'
    ]).join(''),
    ' ',
    piff(n.body)
  ],
  magic: n => n.value,
  switch: n => ['switch', ' ', '(', piff(n.test), ')', piff(n.body)],
  case: n => [
    n.test ? ['case', ' ', piff(n.test)] : 'default',
    ':',
    piff(n.body)
  ],
  break: n => ['break', n.value ? [' ', piff(n.level)] : null],
  exit: n => ['exit', '(', piff(n.status), ')'],
  while: n => ['while', ' ', '(', piff(n.test), ')', piff(n.body)],
  do: n => ['do', piff(n.body), 'while', '(', piff(n.test), ')'],
  cast: n => {
    switch (n.type) {
      case 'boolean':
        return ['!!', piff(n.what)]
      case 'int':
        return ['intval', '(', piff(n.what), ')']
      default:
        throw new Error('unsupported cast to ' + n.type)
    }
  },
  interface: n => [
    'interface',
    ' ',
    n.name,
    ' ',
    n.extends ? ['extends', ' ', piff(n.extends), ' '] : null,
    '{',
    n.body ? inject(n.body.map(piff), '\n') : null,
    '}'
  ],
  static: n => ['static', ' ', inject(n.items.map(piff), ',')],
  doc: n => {
    return ['//', inject(n.lines, ['\n', '//']), '\n']
  }
}

const piff = ast => {
  if (ast === null) return null

  let generator = generators[ast.kind]
  if (generator) {
    // console.log(ast)
  } else {
    throw new Error('kind not recognized' + JSON.stringify(ast))
  }

  return generator(ast)
}

module.exports = function (php, filepath) {
  const ast = parser.parseCode(php, filepath)
  const piffTokens = Lazy(piff(ast)).flatten().compact().toArray()
  return format(piffTokens)
}
