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

# Check standard locations
for candidate in \
  "$(command -v llama-server 2>/dev/null || true)" \
  "/usr/local/lib/ollama/llama-server" \
  "/usr/local/bin/llama-server" \
  "/usr/bin/llama-server" \
  "${INSTALL_BIN_DIR}/llama-server" \
  "${OLLAMA_LITE_BIN}/llama-server"; do
  if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
    LLAMA_SERVER_PATH="${candidate}"
    break
  fi
done

if [ -n "${LLAMA_SERVER_PATH}" ]; then
  echo -e "${GREEN}[OK]${NC} Found llama-server at: ${BOLD}${LLAMA_SERVER_PATH}${NC}"
else
  echo -e "${YELLOW}[WARN]${NC} llama-server not found on system."
  echo -e "${BLUE}[INFO]${NC} Downloading prebuilt llama.cpp binaries for ${OS}-${ARCH_NAME}..."

  mkdir -p "${OLLAMA_LITE_BIN}"
  TMP_DIR="$(mktemp -d)"

  # Map OS name to release asset name
  if [ "${OS}" = "darwin" ]; then
    ASSET_PATTERN="bin-macos-${ARCH_NAME}.tar.gz"
  else
    ASSET_PATTERN="bin-ubuntu-${ARCH_NAME}.tar.gz"
  fi

  # Query latest release asset from GitHub API
  RELEASE_JSON="$(curl -s https://api.github.com/repos/ggml-org/llama.cpp/releases/latest || true)"
  DOWNLOAD_URL="$(echo "${RELEASE_JSON}" | grep "browser_download_url" | grep "${ASSET_PATTERN}" | head -n 1 | cut -d '"' -f 4 || true)"

  if [ -z "${DOWNLOAD_URL}" ]; then
    echo -e "${YELLOW}[WARN]${NC} Could not auto-detect download URL from GitHub API. Falling back to default release asset..."
    DOWNLOAD_URL="https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-bin-ubuntu-${ARCH_NAME}.tar.gz"
  fi

  echo -e "${BLUE}[INFO]${NC} Downloading from: ${DOWNLOAD_URL}"
  if curl -fsSL "${DOWNLOAD_URL}" -o "${TMP_DIR}/llama.tar.gz" 2>/dev/null; then
    tar -xzf "${TMP_DIR}/llama.tar.gz" -C "${TMP_DIR}"
    
    # Locate llama-server inside extracted archive
    EXTRACTED_SERVER="$(find "${TMP_DIR}" -type f -name "llama-server" | head -n 1)"
    if [ -n "${EXTRACTED_SERVER}" ] && [ -f "${EXTRACTED_SERVER}" ]; then
      cp "${EXTRACTED_SERVER}" "${OLLAMA_LITE_BIN}/llama-server"
      chmod +x "${OLLAMA_LITE_BIN}/llama-server"
      LLAMA_SERVER_PATH="${OLLAMA_LITE_BIN}/llama-server"
      echo -e "${GREEN}[OK]${NC} llama-server installed to ${BOLD}${LLAMA_SERVER_PATH}${NC}"
    else
      echo -e "${YELLOW}[WARN]${NC} Could not locate 'llama-server' binary inside archive."
    fi
  else
    echo -e "${YELLOW}[WARN]${NC} Automatic download of llama-server failed. You can install llama.cpp manually or install Ollama."
  fi

  rm -rf "${TMP_DIR}"
fi

# ------------------------------------------------------------------------------
# 4. Install Project Dependencies & Prepare Directories
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Installing project dependencies..."
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
echo -e "${BLUE}[INFO]${NC} Setting up 'ollama-lite' command..."

# Remove any existing symlink or file first
rm -f "${INSTALL_BIN_DIR}/ollama-lite"
if [ -d "${BUN_BIN_DIR}" ]; then
  rm -f "${BUN_BIN_DIR}/ollama-lite"
fi

# Create wrapper script in ~/.local/bin/ollama-lite
cat <<EOF > "${INSTALL_BIN_DIR}/ollama-lite"
#!/usr/bin/env bash
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

PATH_EXPORT="export PATH=\"\$HOME/.local/bin:\$PATH\""

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  if [ -n "${RC_FILE}" ] && [ -f "${RC_FILE}" ]; then
    if ! grep -qs "HOME/.local/bin" "${RC_FILE}"; then
      echo "" >> "${RC_FILE}"
      echo "# Ollama Lite CLI Path" >> "${RC_FILE}"
      echo "${PATH_EXPORT}" >> "${RC_FILE}"
      echo -e "${BLUE}[INFO]${NC} Added ${BOLD}~/.local/bin${NC} to ${BOLD}${RC_FILE}${NC}"
    fi
  fi
  export PATH="${HOME}/.local/bin:${PATH}"
fi

# ------------------------------------------------------------------------------
# 7. Verification
# ------------------------------------------------------------------------------
echo -e "${BLUE}[INFO]${NC} Verifying installation..."
export PATH="${INSTALL_BIN_DIR}:${BUN_BIN_DIR}:${PATH}"

if command -v ollama-lite >/dev/null 2>&1; then
  CLI_VER="$(ollama-lite version 2>/dev/null || echo "v0.1.0")"
  echo -e "${GREEN}${BOLD}[SUCCESS]${NC} Ollama Lite is installed and ready (${CLI_VER})!"
else
  echo -e "${YELLOW}[WARN]${NC} Direct 'ollama-lite' command could not be resolved in the subshell, but wrapper is at ${INSTALL_BIN_DIR}/ollama-lite"
fi

echo -e "\n${CYAN}${BOLD}=======================================================${NC}"
echo -e "${GREEN}${BOLD}             Installation Completed!                   ${NC}"
echo -e "${CYAN}${BOLD}=======================================================${NC}\n"

echo -e "You can now run commands such as:"
echo -e "  ${BOLD}ollama-lite run llama3.2:1b${NC}        # Interactive chat"
echo -e "  ${BOLD}ollama-lite pull qwen2.5:0.5b${NC}      # Download model"
echo -e "  ${BOLD}ollama-lite list${NC}                   # List downloaded models"
echo -e "  ${BOLD}ollama-lite serve${NC}                  # Start HTTP API daemon"
echo -e "  ${BOLD}ollama-lite benchmark llama3.2:1b${NC}  # Benchmark inference"
echo ""
echo -e "If 'ollama-lite' is not recognized in your current shell, reload it with:"
if [ -n "${RC_FILE}" ]; then
  echo -e "  ${BOLD}source ${RC_FILE}${NC}"
else
  echo -e "  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
fi
echo ""
