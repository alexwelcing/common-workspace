import {defineConfig} from 'vite';
export default defineConfig({server:{host:'0.0.0.0',port:5173,proxy:{'/api':{target:'http://127.0.0.1:3001',changeOrigin:false},'/ws':{target:'ws://127.0.0.1:3001',ws:true,changeOrigin:false}}},build:{target:'es2022',chunkSizeWarningLimit:1000}});
