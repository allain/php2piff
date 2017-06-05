const test = require('tape')

// c = convertToPiff
const toPiff = require('..')

const cRaw = php => toPiff(/^<[?]php/.test(php) ? php : '<?php\n' + php)
const c = php => cRaw(php).replace(/\n\s+/g, '\n')

test('empty file works', t => {
  t.equal(toPiff(''), '')
  t.end()
})

test('HTML works', t => {
  t.equal(toPiff('<b>Testing</b>'), 'print("<b>Testing</b>")')
  t.equal(toPiff('<b>\\\\"\\\'\\\\</b>'), 'print("<b>\\\\"\\\'\\\\</b>")')
  t.equal(toPiff('<b>\n</b>'), 'print("<b>\n</b>")')
  t.end()
})

test('classes', t => {
  t.equal(c('class A {}'), 'class A {\n}', 'empty class works')
  t.equal(
    c('class A extends B {}'),
    'class A extends B {\n}',
    'extends is supported'
  )
  t.equal(
    c('class A implements B {}'),
    'class A implements B {\n}',
    'implements is supported'
  )

  t.equal(
    c('class A { public static function a(B $b, $c=null) { return $b; }}'),
    'class A {\nstatic a(B b, c = null) {\nreturn b\n}\n}',
    'complext static method'
  )

  t.equal(
    c('class A { public function a(B $b, $c=null) { return $b; }}'),
    'class A {\na(B b, c = null) {\nreturn b\n}\n}',
    'complex instance method'
  )

  t.equal(
    c('class A { private $a=1; }'),
    'class A {\nprivate a = 1\n}',
    'complex instance property'
  )

  t.equal(
    c('class A { private static $a=1; }'),
    'class A {\nprivate static a = 1\n}',
    'complex static property'
  )

  t.equal(
    c('class A { const A = 1; }'),
    'class A {\nA = 1\n}',
    'class constants'
  )

  t.equal(
    c('class A{ function a() { self::t(); }}'),
    'class A {\na() {\n@@t()\n}\n}',
    'self::method() => @@method()'
  )

  t.equal(
    c('class A{ function a() { A::t(); }}'),
    'class A {\na() {\nA::t()\n}\n}',
    'X::t() => X::t()'
  )

  t.equal(
    c('class A { function a() { p($this->b); }}'),
    'class A {\na() {\np(@b)\n}\n}',
    '$this->a => @a'
  )

  t.equal(
    c('class A { function a() { $this->b(); }}'),
    'class A {\na() {\n@b()\n}\n}',
    '$this->a() => @a()'
  )

  t.equal(c('$a->b->c->d()'), 'a.b.c.d()', 'chains use period')

  t.equal(
    c('class A{ function a() { p(A::$t); }}'),
    'class A {\na() {\np(A::t)\n}\n}',
    'X::$t => X::t'
  )

  t.equal(
    c('function a(B $b=null) { return b; }'),
    'fn a(B b = null) {\nreturn b\n}',
    'named function'
  )

  t.equal(
    c('$a = function (B $b=null) use($x) { return $x + $b; }'),
    'a = fn (B b = null) {\nreturn x + b\n}',
    'closures'
  )

  t.equal(c('"a"."b"'), '"a" + "b"', 'string concatenation uses +')
  t.equal(
    c('(true) . (false)'),
    '"" + (true) + (false)',
    'string concatenation forces concat when neither size is not a string'
  )

  t.equal(c('[1,2,3]'), '[1, 2, 3]', 'simple array')
  t.equal(c('["a" => 1, \'b\' => 2]'), '[a: 1, b: 2]', 'array with mixed keys')
  t.equal(
    c('["a.b" => 1, \'c\' => 2, "d" => 3]'),
    '["a.b": 1, c: 2, d: 3]',
    'array with mixed keys'
  )
  t.equal(c('[1, "a" => 2]'), '[1, a: 2]', 'array with mixed keys')

  t.equal(
    c('1 + 2 * 3 + (1) / 2'),
    '1 + 2 * 3 + (1) / 2',
    'arithmetic expressions are supported'
  )

  t.equal(c('$a = 1'), 'a = 1', 'simple variable assignment')

  t.equal(
    c('foreach($a as $k => $v) {}'),
    'foreach (a as k => v) {\n}',
    'foreach'
  )

  t.equal(
    c('if (1==1) {a();} elseif (2==2) {b();} else {c();}'),
    'if (1 == 1) {\na()\n} else if (2 == 2) {\nb()\n} else {\nc()\n}',
    'full if statement'
  )

  t.equal(
    c('"x{$a}y$b$c"'),
    '"x{a}y{b}{c}"',
    'encapsed strings expand correctly'
  )

  t.equal(
    c('try{}catch(E $e) {}catch(F $f) {}'),
    'try {\n} catch (E e) {\n} catch (F f) {\n}',
    'try catch works'
  )
  t.equal(c('throw new E("a")'), 'throw new E("a")')

  t.equal(
    c('$a=(1>2)?$t:$f'),
    'a = (1 > 2) ? t : f',
    'ternary expressions work'
  )

  t.equal(c('var_dump(!$test);'), 'var_dump(!test)', 'unary prefix works')

  t.equal(c('echo "hello";'), 'echo("hello")', 'echo is handled')

  t.equal(c('for($i=0;$i<10;$i++){}'), 'for (i = 0; i < 10; i++) {\n}')

  t.equal(c('echo __DIR__;'), 'echo(__DIR__)')

  t.equal(
    c(
      'switch ($a) { case "a":\ncase "b":\nb();case "c":\nc();default:\n break;}'
    ),
    'switch (a) {\ncase "a": \ncase "b": {\nb()\n}\ncase "c": {\nc()\n}\ndefault: {\nbreak\n}\n}',
    'switch is supported'
  )

  t.equal(
    c('while (1 > 2) { t(); }'),
    'while (1 > 2) {\nt()\n}',
    'while is supported'
  )

  t.equal(
    c('interface A { public function t(); }'),
    'interface A {\nt()\n}',
    ''
  )

  t.end()
})

test('casting works', t => {
  t.equal(c('(bool)1'), '!!1')
  t.end()
})
