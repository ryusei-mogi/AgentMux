class Agentmux < Formula
  desc "Quota-aware local OpenAI-compatible LLM gateway for coding agents"
  homepage "https://github.com/ryusei-mogi/AgentMux"
  url "https://github.com/ryusei-mogi/AgentMux/releases/download/v0.3.0/ryusei-mogi-agentmux-0.3.0.tgz"
  sha256 "6c90510f6a5827ccfa32c1e992409068a53f0cf5c2fca77d2bfdfd5b4b528fb8"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink libexec/"bin/agentmux"
  end

  test do
    assert_match "0.3.0", shell_output("#{bin}/agentmux --version")
  end
end
