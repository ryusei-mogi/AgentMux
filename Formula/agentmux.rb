class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.5.1/ryusei-mogi-agentmux-0.5.1.tgz"
  sha256 "90398de2d587d057c6b0136482cb2d98aa63d7feefbbff9e826796b5129512d6"
  license "MIT"

  depends_on "node"

  def install
    # Homebrew delays very recent npm dependencies. Allow npm to pick the
    # previous Hono patch release until 4.12.18 clears that safety window.
    inreplace "package.json", '"hono": "^4.12.18"', '"hono": "^4.12.0"'
    system "npm", "install", *std_npm_args(prefix: libexec, ignore_scripts: false)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.5.1", shell_output("#{bin}/agentmux --version")
  end
end
