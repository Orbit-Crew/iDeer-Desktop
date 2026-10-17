/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#1E6FCC',
          light: '#E8F2FF',
          dark: '#154F99'
        },
        // 浅色侧边栏色板
        sidebar: {
          DEFAULT: '#FFFFFF',
          hover: '#F2F4F8',
          active: '#E8F2FF'
        },
        // 边框灰蓝
        line: {
          light: '#EEF0F5',
          DEFAULT: '#E4E8F0'
        }
      },
      boxShadow: {
        card: '0 1px 2px rgba(30, 50, 90, 0.04), 0 1px 6px rgba(30, 50, 90, 0.05)',
        'card-hover': '0 4px 12px rgba(30, 50, 90, 0.08), 0 2px 4px rgba(30, 50, 90, 0.06)',
        popover: '0 6px 24px rgba(30, 50, 90, 0.12), 0 2px 8px rgba(30, 50, 90, 0.08)',
        'focus-ring': '0 0 0 3px rgba(30, 111, 204, 0.12)'
      },
      borderRadius: {
        card: '12px',
        btn: '8px',
        input: '6px'
      },
      fontFamily: {
        sans: ['Inter', '"HarmonyOS Sans SC"', '"思源黑体"', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif']
      }
    }
  },
  plugins: []
}
