/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 是原生模块，仅服务端、不打包进 bundle
  serverExternalPackages: ["better-sqlite3"],
  // lib/ 用 NodeNext 风格的 .js 扩展名导入（实为 .ts）——让 webpack 解析 .js → .ts/.tsx
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
