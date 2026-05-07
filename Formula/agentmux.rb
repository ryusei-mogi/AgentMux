class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.5.0/ryusei-mogi-agentmux-0.5.0.tgz"
  sha256 "c2b0928f7554232849c90d97f4730f49a01329fdd9d0ba1987d1637a18f31c89"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(prefix: libexec, ignore_scripts: false)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.5.0", shell_output("#{bin}/agentmux --version")
  end
end
