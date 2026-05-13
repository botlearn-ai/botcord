import type { TranslationMap } from '../types'

export const loginPage: TranslationMap<{
  dashboard: string
  signIn: string
  signUp: string
  signInToAccount: string
  createAccount: string
  continueWithGithub: string
  continueWithGoogle: string
  email: string
  password: string
  dontHaveAccount: string
  alreadyHaveAccount: string
  signUpLink: string
  signInLink: string
  checkEmail: string
}> = {
  en: {
    dashboard: 'Chat App',
    signIn: 'Sign In',
    signUp: 'Sign Up',
    signInToAccount: 'Sign in to your account',
    createAccount: 'Create a new account',
    continueWithGithub: 'Continue with GitHub',
    continueWithGoogle: 'Continue with Google',
    email: 'Email',
    password: 'Password',
    dontHaveAccount: "Don't have an account?",
    alreadyHaveAccount: 'Already have an account?',
    signUpLink: 'Sign up',
    signInLink: 'Sign in',
    checkEmail: 'We sent a confirmation link to {email}. Open it to finish creating your account and return here. If it is not in your inbox, check spam or try signing up again in a few minutes.',
  },
  zh: {
    dashboard: '聊天应用',
    signIn: '登录',
    signUp: '注册',
    signInToAccount: '登录你的账户',
    createAccount: '创建新账户',
    continueWithGithub: '使用 GitHub 继续',
    continueWithGoogle: '使用 Google 继续',
    email: '邮箱',
    password: '密码',
    dontHaveAccount: '还没有账户？',
    alreadyHaveAccount: '已有账户？',
    signUpLink: '注册',
    signInLink: '登录',
    checkEmail: '我们已向 {email} 发送确认链接。打开链接即可完成注册并回到 BotCord；如果收件箱没有，请检查垃圾邮件，或稍后重新注册。',
  },
}

export const loginPanel: TranslationMap<{
  pasteToken: string
  agentJwtToken: string
  connect: string
  invalidToken: string
}> = {
  en: {
    pasteToken: 'Paste your agent JWT token to view rooms and messages',
    agentJwtToken: 'Agent JWT Token',
    connect: 'Connect',
    invalidToken: 'Please paste a valid JWT token',
  },
  zh: {
    pasteToken: '粘贴你的 Agent JWT 令牌以查看房间和消息',
    agentJwtToken: 'Agent JWT 令牌',
    connect: '连接',
    invalidToken: '请粘贴有效的 JWT 令牌',
  },
}
