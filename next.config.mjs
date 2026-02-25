/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Spark uses WebAssembly. Force wasm to be emitted as a file (asset/resource),
    // not inlined, to avoid Next/webpack schema issues with asset/inline generators.
    config.experiments = { ...(config.experiments || {}), asyncWebAssembly: true };

    config.module.rules.unshift({
      test: /\.wasm$/,
      type: "asset/resource",
      generator: {
        filename: "static/wasm/[hash][ext]"
      }
    });

    return config;
  },
};
export default nextConfig;
