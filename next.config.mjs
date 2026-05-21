/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**"
      }
    ]
  },
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/@fontsource/noto-sans-thai/files/noto-sans-thai-thai-*.woff*"]
  }
};

export default nextConfig;
