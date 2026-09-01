// ContextBridge Options Page with Authentication

const DEFAULT_BACKEND_URL = 'https://api.ctxbridge.io';

// DOM Elements
let elements = {};

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  setupEventListeners();
  await checkAuthState();
});

function cacheElements() {
  elements = {
    // Sections
    authSection: document.getElementById('authSection'),
    loggedInSection: document.getElementById('loggedInSection'),
    
    // Auth forms
    loginForm: document.getElementById('loginForm'),
    registerForm: document.getElementById('registerForm'),
    forgotPasswordForm: document.getElementById('forgotPasswordForm'),
    
    // Login
    loginEmail: document.getElementById('loginEmail'),
    loginPassword: document.getElementById('loginPassword'),
    loginBtn: document.getElementById('loginBtn'),
    forgotPasswordLink: document.getElementById('forgotPasswordLink'),
    
    // Register
    registerName: document.getElementById('registerName'),
    registerEmail: document.getElementById('registerEmail'),
    registerPassword: document.getElementById('registerPassword'),
    registerBtn: document.getElementById('registerBtn'),
    
    // Forgot password
    forgotEmail: document.getElementById('forgotEmail'),
    sendResetBtn: document.getElementById('sendResetBtn'),
    backToLoginLink: document.getElementById('backToLoginLink'),

    // Resend verification
    resendVerificationForm: document.getElementById('resendVerificationForm'),
    resendEmail: document.getElementById('resendEmail'),
    resendBtn: document.getElementById('resendBtn'),
    backToLoginFromResend: document.getElementById('backToLoginFromResend'),
    
    // Tabs
    tabs: document.querySelectorAll('.tab'),
    
    // Logged in section
    userEmail: document.getElementById('userEmail'),
    userName: document.getElementById('userName'),
    logoutBtn: document.getElementById('logoutBtn'),
    
    // Status
    authStatus: document.getElementById('authStatus'),
    settingsStatus: document.getElementById('settingsStatus')
  };
}

function setupEventListeners() {
  // Tab switching
  elements.tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  
  // Login
  elements.loginBtn.addEventListener('click', handleLogin);
  elements.loginPassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  
  // Register
  elements.registerBtn.addEventListener('click', handleRegister);
  elements.registerPassword.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleRegister();
  });
  
  // Forgot password
  elements.forgotPasswordLink.addEventListener('click', showForgotPassword);
  elements.backToLoginLink.addEventListener('click', showLoginForm);
  elements.sendResetBtn.addEventListener('click', handleForgotPassword);

  // Resend verification
  elements.resendBtn.addEventListener('click', handleResendVerification);
  elements.backToLoginFromResend.addEventListener('click', showLoginForm);
  
  // Settings
  elements.logoutBtn.addEventListener('click', handleLogout);
  
}

// Check if user is already logged in
async function checkAuthState() {
  const stored = await chrome.storage.sync.get(['accessToken', 'refreshToken', 'user', 'backendUrl']);
  
  if (stored.accessToken && stored.user) {
    // Verify token is still valid
    const backendUrl = stored.backendUrl || DEFAULT_BACKEND_URL;
    try {
      const response = await fetch(`${backendUrl}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${stored.accessToken}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        showLoggedInState(data.user, backendUrl);
        return;
      } else if (response.status === 401 && stored.refreshToken) {
        // Try to refresh token
        const refreshed = await refreshTokens(backendUrl, stored.refreshToken);
        if (refreshed) {
          showLoggedInState(refreshed.user, backendUrl);
          return;
        }
      }
    } catch (error) {
      console.error('Auth check failed:', error);
    }
    
    // Token invalid, clear storage
    await chrome.storage.sync.remove(['accessToken', 'refreshToken', 'user']);
  }
  
  // Show login form
  showAuthSection();
}

async function refreshTokens(backendUrl, refreshToken) {
  try {
    const response = await fetch(`${backendUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    
    if (response.ok) {
      const data = await response.json();
      await chrome.storage.sync.set({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        user: data.user
      });
      return data;
    }
  } catch (error) {
    console.error('Token refresh failed:', error);
  }
  return null;
}

function showAuthSection() {
  elements.authSection.classList.add('active');
  elements.loggedInSection.classList.remove('active');
}

function showLoggedInState(user, backendUrl) {
  elements.authSection.classList.remove('active');
  elements.loggedInSection.classList.add('active');
  
  elements.userEmail.textContent = user.email;
  elements.userName.textContent = user.name || '';
}

function switchTab(tabName) {
  // Update tab styles
  elements.tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  // Show appropriate form
  elements.loginForm.classList.toggle('hidden', tabName !== 'login');
  elements.registerForm.classList.toggle('hidden', tabName !== 'register');
  elements.forgotPasswordForm.classList.add('hidden');
  
  clearStatus('authStatus');
}

function showForgotPassword() {
  elements.loginForm.classList.add('hidden');
  elements.registerForm.classList.add('hidden');
  elements.forgotPasswordForm.classList.remove('hidden');
  clearStatus('authStatus');
}

function showLoginForm() {
  elements.loginForm.classList.remove('hidden');
  elements.registerForm.classList.add('hidden');
  elements.forgotPasswordForm.classList.add('hidden');
  elements.resendVerificationForm.classList.add('hidden');
  
  // Reset tabs
  elements.tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === 'login');
  });
  
  clearStatus('authStatus');
}

async function handleLogin() {
  const email = elements.loginEmail.value.trim();
  const password = elements.loginPassword.value;
  
  if (!email || !password) {
    showStatus('authStatus', 'Please enter email and password', 'error');
    return;
  }
  
  const backendUrl = await getBackendUrl();
  setButtonLoading(elements.loginBtn, true);
  
  try {
    const response = await fetch(`${backendUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      // Store tokens and user info
      await chrome.storage.sync.set({
        accessToken: data.tokens.accessToken,
        refreshToken: data.tokens.refreshToken,
        user: data.user,
        userId: data.user.id, // For backward compatibility
        backendUrl: backendUrl,
        isAdmin: data.user.is_admin || false
      });
      
      // Notify background script
      chrome.runtime.sendMessage({ 
        type: 'AUTH_STATE_CHANGED', 
        user: data.user,
        backendUrl: backendUrl
      });
      
      showLoggedInState(data.user, backendUrl);
      showStatus('settingsStatus', 'Logged in successfully!', 'success');
    } else {
      if (data.code === 'EMAIL_NOT_VERIFIED') {
        showResendVerification(email);
      } else {
        showStatus('authStatus', data.error || 'Login failed', 'error');
      }
    }
  } catch (error) {
    showStatus('authStatus', 'Connection failed. Check your internet connection.', 'error');
  } finally {
    setButtonLoading(elements.loginBtn, false);
  }
}

async function handleRegister() {
  const name = elements.registerName.value.trim();
  const email = elements.registerEmail.value.trim();
  const password = elements.registerPassword.value;
  
  if (!email || !password) {
    showStatus('authStatus', 'Please enter email and password', 'error');
    return;
  }
  
  if (password.length < 8) {
    showStatus('authStatus', 'Password must be at least 8 characters', 'error');
    return;
  }
  
  const backendUrl = await getBackendUrl();
  setButtonLoading(elements.registerBtn, true);
  
  try {
    const response = await fetch(`${backendUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      showStatus('authStatus', 'Account created! Please check your email to verify your account.', 'success');
      // Switch to login tab
      setTimeout(() => switchTab('login'), 2000);
    } else {
      showStatus('authStatus', data.error || 'Registration failed', 'error');
    }
  } catch (error) {
    showStatus('authStatus', 'Connection failed. Check your internet connection.', 'error');
  } finally {
    setButtonLoading(elements.registerBtn, false);
  }
}

async function handleForgotPassword() {
  const email = elements.forgotEmail.value.trim();
  
  if (!email) {
    showStatus('authStatus', 'Please enter your email', 'error');
    return;
  }
  
  const backendUrl = await getBackendUrl();
  setButtonLoading(elements.sendResetBtn, true);
  
  try {
    const response = await fetch(`${backendUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      showStatus('authStatus', data.message || 'If an account exists, a reset link has been sent.', 'success');
    } else {
      showStatus('authStatus', data.error || 'Request failed', 'error');
    }
  } catch (error) {
    showStatus('authStatus', 'Connection failed. Check your internet connection.', 'error');
  } finally {
    setButtonLoading(elements.sendResetBtn, false);
  }
}

function showResendVerification(email) {
  elements.loginForm.classList.add('hidden');
  elements.registerForm.classList.add('hidden');
  elements.forgotPasswordForm.classList.add('hidden');
  elements.resendVerificationForm.classList.remove('hidden');
  
  // Pre-fill email if provided
  if (email) {
    elements.resendEmail.value = email;
  }
  
  showStatus('authStatus', 'Please verify your email before logging in.', 'error');
}

async function handleResendVerification() {
  const email = elements.resendEmail.value.trim();
  
  if (!email) {
    showStatus('authStatus', 'Please enter your email', 'error');
    return;
  }
  
  const backendUrl = await getBackendUrl();
  setButtonLoading(elements.resendBtn, true);
  
  try {
    const response = await fetch(`${backendUrl}/api/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      showStatus('authStatus', 'Verification email sent! Check your inbox and spam folder.', 'success');
    } else {
      showStatus('authStatus', data.error || 'Failed to resend verification email', 'error');
    }
  } catch (error) {
    showStatus('authStatus', 'Connection failed. Check your internet connection.', 'error');
  } finally {
    setButtonLoading(elements.resendBtn, false);
  }
}

async function handleLogout() {
  const stored = await chrome.storage.sync.get(['refreshToken', 'backendUrl']);
  const backendUrl = stored.backendUrl || DEFAULT_BACKEND_URL;
  
  // Call logout endpoint (best effort)
  try {
    await fetch(`${backendUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: stored.refreshToken })
    });
  } catch (error) {
    console.log('Logout request failed (non-critical):', error);
  }
  
  // Clear stored auth data
  await chrome.storage.sync.remove(['accessToken', 'refreshToken', 'user', 'userId']);
  
  // Notify background script
  chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', user: null });
  
  // Show login form
  showAuthSection();
  showStatus('authStatus', 'Logged out successfully', 'success');
}

async function getBackendUrl() {
  const stored = await chrome.storage.sync.get(['backendUrl']);
  return stored.backendUrl || DEFAULT_BACKEND_URL;
}

function showStatus(elementId, message, type) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.className = `status ${type}`;
}

function clearStatus(elementId) {
  const el = document.getElementById(elementId);
  el.textContent = '';
  el.className = 'status';
}

function setButtonLoading(button, loading) {
  if (loading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.innerHTML = '<span class="loading"></span>Loading...';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}