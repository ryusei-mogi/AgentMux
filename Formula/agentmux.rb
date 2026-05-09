class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.6.0/ryusei-mogi-agentmux-0.6.0.tgz"
  sha256 "fdef5e92041ada3ac68bb34bb982189ad26ea49a3d6c242a98d5ba8175e3a939"
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
    assert_match "0.6.0", shell_output("#{bin}/agentmux --version")
  end
end
