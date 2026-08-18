#!/usr/bin/env bash

# ==============================================================================
# Ollama Lite - Installer & Dependency Setup
# ==============================================================================

set -euo pipefail

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_BIN_DIR="${HOME}/.local/bin"
BUN_BIN_DIR="${HOME}/.bun/bin"
OLLAMA_LITE_HOME="${HOME}/.ollama-lite"
OLLAMA_LITE_BIN="${OLLAMA_LITE_HOME}/bin"

echo -e "${CYAN}${BOLD}"
echo "======================================================="
echo "            Ollama Lite Installation Script            "
echo "======================================================="
echo -e "${NC}"

# ------------------------------------------------------------------------------
# 1. Detect OS & Architecture
# ------------------------------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "${ARCH}" in
  x86_64|amd64)
    ARCH_NAME="x64"
    ;;
  aarch64|arm64)
    ARCH_NAME="arm64"
    ;;
  *)
    echo -e "${RED}Error: Unsupported architecture: ${ARCH}${NC}"
    exit 1
    ;;
esac

echo -e "${BLUE}[INFO]${NC} Detected Platform: ${BOLD}${OS}-${ARCH_NAME}${NC}"

# ------------------------------------------------------------------------------
# 2. Check / Install Bun
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Checking for Bun runtime..."

if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version)"
  echo -e "${GREEN}[OK]${NC} Found Bun ${BOLD}v${BUN_VERSION}${NC} at $(which bun)"
elif [ -x "${BUN_BIN_DIR}/bun" ]; then
  export PATH="${BUN_BIN_DIR}:${PATH}"
  BUN_VERSION="$(bun --version)"
  echo -e "${GREEN}[OK]${NC} Found Bun ${BOLD}v${BUN_VERSION}${NC} at ${BUN_BIN_DIR}/bun"
else
  echo -e "${YELLOW}[WARN]${NC} Bun not found in PATH. Installing Bun..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | bash
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://bun.sh/install | bash
  else
    echo -e "${RED}Error: curl or wget is required to install Bun.${NC}"
    exit 1
  fi

  export PATH="${BUN_BIN_DIR}:${PATH}"

  if ! command -v bun >/dev/null 2>&1; then
    echo -e "${RED}Error: Bun installation finished but 'bun' executable was not found.${NC}"
    exit 1
  fi
  echo -e "${GREEN}[OK]${NC} Bun installed successfully: $(bun --version)"
fi

# ------------------------------------------------------------------------------
# 3. Check / Install llama-server (llama.cpp)
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Checking for llama-server backend..."

LLAMA_SERVER_PATH=""

# Check standard system and package locations
for candidate in \
  "$(command -v llama-server 2>/dev/null || true)" \
  "${OLLAMA_LITE_BIN}/llama-server" \
  "${INSTALL_BIN_DIR}/llama-server" \
  "/usr/local/bin/llama-server" \
  "/usr/bin/llama-server" \
  "/opt/llama.cpp/llama-server" \
  "/opt/llama.cpp/build/bin/llama-server" \
  "/opt/homebrew/bin/llama-server" \
  "/usr/local/lib/ollama/llama-server" \
  "/usr/local/lib/ollama/runners/cpu/llama-server" \
  "/usr/lib/ollama/llama-server"; do
  if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
    LLAMA_SERVER_PATH="${candidate}"
    break
  fi
done

if [ -n "${LLAMA_SERVER_PATH}" ]; then
  echo -e "${GREEN}[OK]${NC} Found llama-server at: ${BOLD}${LLAMA_SERVER_PATH}${NC}"
else
  echo -e "${YELLOW}[WARN]${NC} llama-server not found on system."
  echo -e "${BLUE}[INFO]${NC} Downloading prebuilt llama.cpp release for ${OS}-${ARCH_NAME}..."

  mkdir -p "${OLLAMA_LITE_BIN}"
  TMP_DIR="$(mktemp -d)"

  # Determine platform label for llama.cpp release assets
  if [ "${OS}" = "darwin" ]; then
    OS_NAME="macos"
  else
    OS_NAME="ubuntu"
  fi

  ASSET_PATTERN="bin-${OS_NAME}-${ARCH_NAME}.tar.gz"

  # Resolve latest release tag from GitHub redirect (avoids API rate limiting)
  RELEASE_TAG="$(curl -sIL -o /dev/null -w '%{url_effective}' https://github.com/ggml-org/llama.cpp/releases/latest 2>/dev/null | sed -e 's|.*/tag/||' -e 's|.*/||' || true)"

  if [ -n "${RELEASE_TAG}" ] && [ "${RELEASE_TAG}" != "latest" ]; then
    DOWNLOAD_URL="https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}/llama-${RELEASE_TAG}-bin-${OS_NAME}-${ARCH_NAME}.tar.gz"
  else
    # Fallback to GitHub API query
    RELEASE_JSON="$(curl -s https://api.github.com/repos/ggml-org/llama.cpp/releases/latest 2>/dev/null || true)"
    DOWNLOAD_URL="$(echo "${RELEASE_JSON}" | grep "browser_download_url" | grep "${ASSET_PATTERN}" | head -n 1 | cut -d '"' -f 4 || true)"
  fi

  if [ -z "${DOWNLOAD_URL}" ]; then
    echo -e "${YELLOW}[WARN]${NC} Could not determine download URL for llama.cpp release."
  else
    echo -e "${BLUE}[INFO]${NC} Downloading from: ${DOWNLOAD_URL}"
    if curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_DIR}/llama.tar.gz" 2>/dev/null; then
      tar -xzf "${TMP_DIR}/llama.tar.gz" -C "${TMP_DIR}"

      # Locate directory containing extracted llama-server
      SERVER_FILE="$(find "${TMP_DIR}" -type f -name "llama-server" | head -n 1)"
      if [ -n "${SERVER_FILE}" ] && [ -f "${SERVER_FILE}" ]; then
        EXTRACTED_DIR="$(dirname "${SERVER_FILE}")"
        # Copy llama-server AND all companion dynamic libraries (.so / .dylib)
        cp -r "${EXTRACTED_DIR}"/* "${OLLAMA_LITE_BIN}/"
        chmod +x "${OLLAMA_LITE_BIN}/llama-server"
        LLAMA_SERVER_PATH="${OLLAMA_LITE_BIN}/llama-server"
        echo -e "${GREEN}[OK]${NC} llama-server and shared runtime libraries installed to ${BOLD}${OLLAMA_LITE_BIN}${NC}"
      else
        echo -e "${YELLOW}[WARN]${NC} Could not locate 'llama-server' binary inside extracted archive."
      fi
    else
      echo -e "${YELLOW}[WARN]${NC} Automatic download of llama-server failed. You can install llama.cpp or Ollama manually."
    fi
  fi

  rm -rf "${TMP_DIR}"
fi

# ------------------------------------------------------------------------------
# 4. Install Project Dependencies & Prepare Directories
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Installing project dependencies with Bun..."
cd "${SCRIPT_DIR}"
bun install

mkdir -p "${INSTALL_BIN_DIR}"
mkdir -p "${OLLAMA_LITE_HOME}/models/manifests"
mkdir -p "${OLLAMA_LITE_HOME}/models/blobs"
mkdir -p "${OLLAMA_LITE_HOME}/runtime"

chmod +x "${SCRIPT_DIR}/bin/ollama-lite"
chmod +x "${SCRIPT_DIR}/src/index.ts"

# ------------------------------------------------------------------------------
# 5. Link / Install CLI Executable
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Setting up 'ollama-lite' CLI executable..."

# Clean old links
rm -f "${INSTALL_BIN_DIR}/ollama-lite"
if [ -d "${BUN_BIN_DIR}" ]; then
  rm -f "${BUN_BIN_DIR}/ollama-lite"
fi

# Create wrapper script in ~/.local/bin/ollama-lite with Bun auto-discovery
cat <<EOF > "${INSTALL_BIN_DIR}/ollama-lite"
#!/usr/bin/env bash
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "\$HOME/.bun/bin/bun" ]; then
    export PATH="\$HOME/.bun/bin:\$PATH"
  fi
fi
exec bun "${SCRIPT_DIR}/src/index.ts" "\$@"
EOF
chmod +x "${INSTALL_BIN_DIR}/ollama-lite"

# Also link in ~/.bun/bin if directory exists
if [ -d "${BUN_BIN_DIR}" ]; then
  ln -sf "${INSTALL_BIN_DIR}/ollama-lite" "${BUN_BIN_DIR}/ollama-lite"
fi

# ------------------------------------------------------------------------------
# 6. Ensure PATH Configuration
# ------------------------------------------------------------------------------
SHELL_NAME="$(basename "${SHELL:-bash}")"
RC_FILE=""

case "${SHELL_NAME}" in
  zsh)
    RC_FILE="${HOME}/.zshrc"
    ;;
  bash)
    if [ -f "${HOME}/.bashrc" ]; then
      RC_FILE="${HOME}/.bashrc"
    elif [ -f "${HOME}/.bash_profile" ]; then
      RC_FILE="${HOME}/.bash_profile"
    fi
    ;;
  *)
    RC_FILE="${HOME}/.profile"
    ;;
esac

# Export in current script execution
export PATH="${INSTALL_BIN_DIR}:${BUN_BIN_DIR}:${PATH}"

# Add ~/.local/bin and ~/.bun/bin to shell RC file if not present
if [ -n "${RC_FILE}" ] && [ -f "${RC_FILE}" ]; then
  NEEDS_UPDATE=false
  RC_ADDITIONS=""

  if ! grep -qs "HOME/\.local/bin" "${RC_FILE}" && ! grep -qs "\.local/bin" "${RC_FILE}"; then
    RC_ADDITIONS="${RC_ADDITIONS}\nexport PATH=\"\$HOME/.local/bin:\$PATH\""
    NEEDS_UPDATE=true
  fi

  if [ -d "${BUN_BIN_DIR}" ] && ! grep -qs "HOME/\.bun/bin" "${RC_FILE}" && ! grep -qs "\.bun/bin" "${RC_FILE}"; then
    RC_ADDITIONS="${RC_ADDITIONS}\nexport PATH=\"\$HOME/.bun/bin:\$PATH\""
    NEEDS_UPDATE=true
  fi

  if [ "${NEEDS_UPDATE}" = true ]; then
    echo "" >> "${RC_FILE}"
    echo "# Ollama Lite & Bun CLI Path" >> "${RC_FILE}"
    echo -e "${RC_ADDITIONS}" >> "${RC_FILE}"
    echo -e "${BLUE}[INFO]${NC} Updated PATH configuration in ${BOLD}${RC_FILE}${NC}"
  fi
fi

# ------------------------------------------------------------------------------
# 7. Verification
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Verifying installation..."

if command -v ollama-lite >/dev/null 2>&1; then
  CLI_VER="$(ollama-lite version 2>/dev/null || echo "v0.1.0")"
  echo -e "${GREEN}${BOLD}[SUCCESS]${NC} Ollama Lite is installed and ready (${CLI_VER})!"
else
  echo -e "${YELLOW}[WARN]${NC} 'ollama-lite' wrapper is at ${INSTALL_BIN_DIR}/ollama-lite"
fi

echo -e "\n${CYAN}${BOLD}=======================================================${NC}"
echo -e "${GREEN}${BOLD}             Installation Completed!                   ${NC}"
echo -e "${CYAN}${BOLD}=======================================================${NC}\n"

echo -e "Quick Start Commands:"
echo -e "  ${BOLD}ollama-lite run llama3.2:1b${NC}             # Run Hugging Face model"
echo -e "  ${BOLD}ollama-lite run ollama:deepseek-r1:8b${NC}   # Run official Ollama model"
echo -e "  ${BOLD}ollama-lite import-ollama${NC}                 # Import existing ~/.ollama models"
echo -e "  ${BOLD}ollama-lite pull smollm:135m${NC}              # Download model"
echo -e "  ${BOLD}ollama-lite list${NC}                        # List installed models"
echo -e "  ${BOLD}ollama-lite serve${NC}                       # Start HTTP API server (11434)"
echo -e "  ${BOLD}ollama-lite benchmark llama3.2:1b${NC}       # Run inference benchmark"
echo ""
echo -e "If 'ollama-lite' is not immediately recognized in your current terminal, run:"
if [ -n "${RC_FILE}" ]; then
  echo -e "  ${BOLD}source ${RC_FILE}${NC}"
else
  echo -e "  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
fi
echo ""
