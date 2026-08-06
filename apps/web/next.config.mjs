/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@memecoin-alpha/shared",
    "@memecoin-alpha/config",
    "@memecoin-alpha/core",
    "@memecoin-alpha/scoring"
  ]
};

export default nextConfig;

