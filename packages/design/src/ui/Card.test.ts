import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import Card from "./Card.vue"

describe("Card", () => {
	it("renders slot content", () => {
		const wrapper = mount(Card, { slots: { default: "<p>hello</p>" } })
		expect(wrapper.html()).toContain("hello")
	})

	it("renders as an <article>", () => {
		const wrapper = mount(Card, { slots: { default: "x" } })
		expect(wrapper.element.tagName).toBe("ARTICLE")
	})

	it("applies the card class to the root", () => {
		const wrapper = mount(Card, { slots: { default: "x" } })
		expect(wrapper.classes()).toContain("card")
	})

	it("forwards data-testid attribute to the root", () => {
		const wrapper = mount(Card, {
			attrs: { "data-testid": "fa-card" },
			slots: { default: "x" },
		})
		expect(wrapper.attributes("data-testid")).toBe("fa-card")
	})

	it("renders nested complex slot content", () => {
		const wrapper = mount(Card, {
			slots: {
				default: '<h2>Title</h2><p data-testid="body">Body</p>',
			},
		})
		expect(wrapper.find("h2").text()).toBe("Title")
		expect(wrapper.find('[data-testid="body"]').text()).toBe("Body")
	})
})
