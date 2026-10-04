// geoip-country ships no types; only the lookup this app uses is declared.
declare module 'geoip-country' {
  const geoip: {
    lookup(ip: string): { country: string } | null;
  };
  export default geoip;
}
