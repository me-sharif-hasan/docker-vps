/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        poppins: ['Poppins', 'sans-serif'],
        dm: ['DM Sans', 'sans-serif']
      },
      boxShadow: {
        '3xl': '14px 17px 40px 4px'
      }
    },
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#ffffff',
      black: '#000000',
      lightPrimary: '#F4F7FE',
      gray: {
        50: '#f8f9fa', 100: '#edf2f7', 200: '#e9ecef', 300: '#cbd5e0',
        400: '#a0aec0', 500: '#adb5bd', 600: '#a3aed0', 700: '#707eae',
        800: '#252f40', 900: '#1b2559'
      },
      navy: {
        50: '#d0dcfb', 100: '#aac0fe', 200: '#a3b9f8', 300: '#728fea',
        400: '#3652ba', 500: '#1b3bbb', 600: '#24388a', 700: '#1B254B',
        800: '#111c44', 900: '#0b1437'
      },
      red: { 50: '#fee2e2', 100: '#fee2e2', 500: '#f53939', 600: '#ea0606', 700: '#b91c1c' },
      green: { 50: '#dcfce7', 100: '#dcfce7', 500: '#22c55e', 600: '#17ad37', 700: '#15803d' },
      amber: { 50: '#fffbeb', 100: '#fef3c7', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
      blue: { 50: '#eff6ff', 100: '#dbeafe', 500: '#3b82f6', 600: '#2152ff', 700: '#1d4ed8' },
      purple: { 50: '#faf5ff', 100: '#f3e8ff', 500: '#a855f7', 600: '#9333ea', 700: '#7928ca' },
      brand: {
        50: '#E9E3FF', 100: '#C0B8FE', 200: '#A195FD', 300: '#8171FC',
        400: '#7551FF', 500: '#422AFB', 600: '#3311DB', 700: '#2111A5',
        800: '#190793', 900: '#11047A'
      },
      brandLinear: '#868CFF',
      shadow: { 500: 'rgba(112, 144, 176, 0.08)' }
    }
  },
  plugins: []
}
