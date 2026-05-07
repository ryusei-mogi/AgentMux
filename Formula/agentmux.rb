class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.5.0/ryusei-mogi-agentmux-0.5.0.tgz"
  sha256 "4182bf609cb4fbdd1f3e723db45eb74c02b9100a724f8b28b99e024afaeb4535"
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
    assert_match "0.5.0", shell_output("#{bin}/agentmux --version")
  end
end
