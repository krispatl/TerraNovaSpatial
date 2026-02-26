/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Helps Next transpile Spark correctly in some setups
  transpilePackages: ["@sparkjsdev/spark"],

  webpack: (config) => {
    // Enable async WebAssembly (Spark uses wasm)
    config.experiments = {
      ...(config.experiments || {}),
      asyncWebAssembly: true,
    };

    // IMPORTANT: Spark's Next.js example notes a Webpack issue where WASM URL
    // resolution breaks because webpack parses `new URL()` in JS.
    // Disabling that parser fixes builds in webpack environments.
    config.module.parser = {
      ...(config.module.parser || {}),
      javascript: {
        ...(config.module.parser?.javascript || {}),
        url: false,
      },
    };

    return config;
  },
};

export default nextConfig;
