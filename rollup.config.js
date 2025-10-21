import resolve from '@rollup/plugin-node-resolve';
import worker from 'rollup-plugin-web-worker-loader';
import babel from '@rollup/plugin-babel';
import filesize from 'rollup-plugin-filesize';
import copy from 'rollup-plugin-copy';
import { eslint } from 'rollup-plugin-eslint';
import { terser } from 'rollup-plugin-terser';

const extensions = ['.js', '.ts'];
export default {
  input: 'src/lib/audio-file-decoder.ts',
  output: {
    file: 'dist/audio-file-decoder.js',
    format: 'esm',
  },
  plugins: [
    resolve({ browser: true, extensions }),
    eslint({ exclude: ['node_modules/**', 'src/wasm/**'] }),
    worker({ targetPlatform: 'browser' }),
    babel({
      presets: [
        '@babel/preset-env',
        '@babel/preset-typescript',
      ],
      plugins: [
        '@babel/plugin-proposal-class-properties',
        '@babel/plugin-transform-runtime',
      ],
      exclude: ['node_modules/**', 'src/wasm/**'],
      extensions,
      babelHelpers: 'runtime',
    }),
    terser(),
    filesize(),
    copy({
      targets: [
        // Copy wasm to dist for proper bundler resolution
        { src: 'src/wasm/decode-audio.wasm', dest: 'dist' },
        // Also copy to root for backward compatibility
        { src: 'src/wasm/decode-audio.wasm', dest: '.' },
      ]
    }),
  ],
};