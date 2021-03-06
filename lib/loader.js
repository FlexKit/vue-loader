var loaderUtils = require('loader-utils')
var assign = require('object-assign')
var parse = require('./parser')
var selectorPath = require.resolve('./selector')
var hash = require('hash-sum')
var path = require('path')

var defaultLang = {
  template: 'html',
  partials: 'html',
  style: 'css',
  script: 'js'
}

var rewriterInjectRE = /\b((css|(vue-)?html)(-loader)?(\?[^!]+)?)(?:!|$)/
var rewriters = {
  template: require.resolve('./template-rewriter'),
  style: require.resolve('./style-rewriter')
}

var templateLoader = require.resolve('./template-loader')

module.exports = function (content) {
  var defaultLoaders = {
    html: 'vue-html-loader',
    css: 'vue-style-loader!css-loader',
    js: 'babel-loader?presets[]=es2015&plugins[]=transform-runtime&comments=false'
  }

  this.cacheable()
  var loaderContext = this
  var options = this.options.vue || {}
  var query = loaderUtils.parseQuery(this.query)
  var filePath = this.resourcePath
  var fileName = path.basename(filePath)
  var moduleId = '_v-' + hash(filePath)

  // respect user babel options
  if (this.options.babel) {
    defaultLoaders.js = 'babel-loader'
  }

  // enable css source map if needed
  var useSourceMap = this.sourceMap && !this.minimize &&
      options.cssSourceMap !== false &&
      process.env.NODE_ENV !== 'production'

  if (useSourceMap) {
    defaultLoaders.css = 'vue-style-loader!css-loader?sourceMap'
  }

  // check if there are custom loaders specified via
  // webpack config, otherwise use defaults
  var loaders = assign({}, defaultLoaders, options.loaders)

  function getRequire (type, part, index, scoped) {
    return 'require(' +
      getRequireString(type, part, index, scoped) +
    ')\n'
  }

  function getRequireString (type, part, index, scoped) {
    return loaderUtils.stringifyRequest(loaderContext,
      // disable all configuration loaders
      '!!' +
      // get loader string for pre-processors
      getLoaderString(type, part, scoped) +
      // select the corresponding part from the vue file
      getSelectorString(type, index || 0) +
      // the url to the actual vuefile
      filePath
    )
  }

  function getRequireForImport (type, impt, scoped) {
    return 'require(' +
      getRequireForImportString(type, impt, scoped) +
    ')\n'
  }

  function getRequireForImportString (type, impt, scoped) {
    return loaderUtils.stringifyRequest(loaderContext,
      '!!' +
      getLoaderString(type, impt, scoped) +
      impt.src
    )
  }

  function getLoaderString (type, part, scoped) {
    var lang = part.lang || defaultLang[type]
    var loader = loaders[lang]
    var rewriter = getRewriter(type, scoped)
    var injectString = (type === 'script' && query.inject) ? 'inject!' : ''
    if (loader !== undefined) {
      // inject rewriter before css/html loader for
      // extractTextPlugin use cases
      if (rewriterInjectRE.test(loader)) {
        loader = loader.replace(rewriterInjectRE, function (m, $1) {
          return ensureBang(ensureLocalIdentName($1)) + rewriter
        })
      } else {
        loader = ensureBang(loader) + rewriter
      }
      return injectString + ensureBang(loader)
    } else {
      // unknown lang, infer the loader to be used
      switch (type) {
        case 'partials':
        case 'template':
          return defaultLoaders.html + '!' + rewriter + templateLoader + '?raw&engine=' + lang + '!'
        case 'style':
          var suffixLoader = ''
          if (part.imported) {
            suffixLoader = useSourceMap ? '&' : '?'
            suffixLoader += 'localIdentName=[name]__[local]___[hash:base64:5]'
          }
          return defaultLoaders.css + suffixLoader + '!' + rewriter + lang + '!'
        case 'script':
          return injectString + lang + '!'
      }
    }
  }

  function getRewriter (type, scoped) {
    var meta = '?id=' + moduleId
    switch (type) {
      case 'partials':
      case 'template':
        return scoped ? (rewriters.template + meta + '!') : ''
      case 'style':
        return rewriters.style + (scoped ? meta + '&scoped=true!' : '!')
      default:
        return ''
    }
  }

  function getSelectorString (type, index) {
    return selectorPath +
      '?type=' + type +
      '&index=' + index + '!'
  }

  function ensureBang (loader) {
    if (loader.charAt(loader.length - 1) !== '!') {
      return loader + '!'
    } else {
      return loader
    }
  }

  function ensureLocalIdentName (loader) {
    var suffixLoader = /\?/.test(loader) ? '&' : '?'

    if (!/localIdentName/.test(loader)) {
      loader += suffixLoader + 'localIdentName=[name]__[local]___[hash:base64:5]'
    }

    return loader
  }

  var parts = parse(content, fileName, this.sourceMap)
  var hasLocalStyles = false
  var output = 'var __vue_script__, __vue_template__, __vue_partials__, __vue_styles__\n'

  // check if there are any template syntax errors
  var templateWarnings = parts.template.length && parts.template[0].warnings
  if (templateWarnings) {
    templateWarnings.forEach(this.emitError)
  }

  // add requires for src imports
  parts.styleImports.forEach(function (impt) {
    if (impt.scoped) hasLocalStyles = true
    output += getRequireForImport('style', impt, impt.scoped)
  })

  // add requires for styles
  parts.style.forEach(function (style, i) {
    if (style.scoped) hasLocalStyles = true
    if (style.imported) output += '__vue_styles__ = '
    output += getRequire('style', style, i, style.scoped)
  })

  // add require for script
  var script
  if (parts.script.length) {
    script = parts.script[0]
    output +=
      '__vue_script__ = ' + (
        script.src
          ? getRequireForImport('script', script, 0)
          : getRequire('script', script, 0)
      )
    // check and warn named exports
    if (!this.minimize) {
      output +=
        'if (__vue_script__ &&\n' +
        '    __vue_script__.__esModule &&\n' +
        '    Object.keys(__vue_script__).length > 1) {\n' +
        '  console.warn(' + JSON.stringify(
            '[vue-loader] ' + path.relative(process.cwd(), filePath) +
            ': named exports in *.vue files are ignored.'
          ) + ')' +
        '}\n'
    }
  }

  // add require for template
  var template
  if (parts.template.length) {
    template = parts.template[0]
    output += '__vue_template__ = ' + (
        template.src
          ? getRequireForImport('template', template, hasLocalStyles)
          : getRequire('template', template, 0, hasLocalStyles)
      )
  }

  // add require for partials
  if (parts.partials.length) {
    output += '__vue_partials__ = {\n'
    parts.partials.forEach(function (partial, i) {
      output += i ? ',' : ''
      output += '"' + [partial.name] + '" : ' + (
          partial.src
            ? getRequireForImport('partials', partial, hasLocalStyles)
            : getRequire('partials', partial, i, hasLocalStyles)
        )
    })
    output += '}\n'
  }

  if (!query.inject) {
    // attach template
    output +=
      'module.exports = __vue_script__ || {}\n' +
      'if (module.exports.__esModule) module.exports = module.exports.default\n' +
      'if (__vue_template__) {\n' +
        '(typeof module.exports === "function" ' +
          '? (module.exports.options || (module.exports.options = {})) ' +
          ': module.exports).template = __vue_template__\n' +
      '}\n' +
      'if (__vue_partials__) {\n' +
        '(typeof module.exports === "function" ' +
          '? (module.exports.options || (module.exports.options = {})) ' +
          ': module.exports).partials = __vue_partials__\n' +
      '}\n' +
      'if (__vue_styles__) {\n' +
        'var exportsIsFunc = (typeof module.exports === "function");\n' +
        'var hasOptions = (exportsIsFunc && module.exports.options);\n' +
        'exportsIsFunc && !hasOptions && (module.exports.options = {});\n' +
        'var hasComputed = (exportsIsFunc && hasOptions ? module.exports.options.computed : module.exports.computed);\n' +
        '(!hasComputed && (hasOptions ? (module.exports.options.computed = {}) : (module.exports.computed = {})));\n' +
        '(hasOptions ' +
          '? module.exports.options.computed ' +
          ': module.exports.computed)[\'styles\'] = function () { return __vue_styles__};\n' +
      '}\n'
    // hot reload
    if (
      !this.minimize &&
      process.env.NODE_ENV !== 'production' &&
      (parts.script.length || parts.template.length)
    ) {
      var hotId = JSON.stringify(moduleId + '/' + fileName)
      output +=
        'if (module.hot) {(function () {' +
        '  module.hot.accept()\n' +
        '  var hotAPI = require("vue-hot-reload-api")\n' +
        '  hotAPI.install(require("vue"), false)\n' +
        '  if (!hotAPI.compatible) return\n' +
        '  var id = ' + hotId + '\n' +
        '  if (!module.hot.data) {\n' +
        // initial insert
        '    hotAPI.createRecord(id, module.exports)\n' +
        '  } else {\n' +
        // update
        '    hotAPI.update(id, module.exports, __vue_template__)\n' +
        '  }\n' +
        '})()}'
    }
  } else {
    output +=
      'module.exports = function (injections) {\n' +
      '  var mod = __vue_script__\n' +
      '    ? __vue_script__(injections)\n' +
      '    : {}\n' +
      '  if (mod.__esModule) mod = mod.default\n' +
      '  if (__vue_template__) { (typeof mod === "function" ? mod.options : mod).template = __vue_template__ }\n' +
      '  return mod\n' +
      '}'
  }

  // done
  return output
}

module.exports.withLoaders = function () {
  throw new Error(
    'vue.withLoaders has been deprecated in vue-loader 6.0. ' +
    'Add a "vue" section to the webpack config instead.'
  )
}
