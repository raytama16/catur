/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Aplikasi ini murni sisi klien (tanpa API route, tanpa database).
  // Otak permainan ada di browser; sinkronisasi lewat broker MQTT publik.
};
export default nextConfig;
