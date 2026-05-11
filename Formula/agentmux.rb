class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.7.0/ryusei-mogi-agentmux-0.7.0.tgz"
  sha256 "9e449432ff5cf4ae92f9ed14948a0d4871c06aa79d8fc9c36914b2b290c1a539"
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
    assert_match "0.7.0", shell_output("#{bin}/agentmux --version")
  end
end
