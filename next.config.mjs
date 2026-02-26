/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  transpilePackages: ["@sparkjsdev/spark"],

  webpack: (config) => {
    // Enable async WebAssembly (required by Spark)
    config.experiments = {
      ...(config.experiments || {}),
      asyncWebAssembly: true,
    };

    return config;
  },
};

export default nextConfig;
